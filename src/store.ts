import type { Batch, Env, NewBatch } from './types.ts';
import { HttpError, MAX_PENDING_BYTES, MAX_RECEIPTS } from './types.ts';

export async function getBatch(env: Env, id: string): Promise<Batch | null> {
  return env.DB.prepare('SELECT * FROM batches WHERE id = ?').bind(id).first<Batch>();
}
export function receipt(b: Batch) {
  return { batch_id: b.id, status: b.state, source: b.source, record_count: b.record_count,
    received_at: b.received_at, archived_at: b.archived_at,
    commit_sha: b.commit_sha, error: b.last_error };
}
export async function accept(env: Env, batch: NewBatch) {
  const { id, envelope, archive_hash, source, record_count, archive_path, received_at } = batch;
  const bytes = new TextEncoder().encode(envelope).byteLength;
  // Capacity check and insertion share a single serialized SQL statement. Competing
  // uploads cannot both reserve the last space using an earlier count.
  await env.DB.prepare(`INSERT INTO batches
    (id, archive_hash, envelope, payload_bytes, source, record_count, archive_path, received_at, state)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'queued'
    WHERE (SELECT COUNT(*) FROM batches) < ?
      AND COALESCE((SELECT SUM(payload_bytes) FROM batches WHERE envelope IS NOT NULL), 0) + ? <= ?
    ON CONFLICT(id) DO NOTHING`).bind(id, archive_hash, envelope, bytes, source, record_count, archive_path, received_at,
      MAX_RECEIPTS, bytes, MAX_PENDING_BYTES).run();
  const b = await getBatch(env, id);
  if (!b) throw new HttpError(503, 'inbox_capacity_reached');
  return b;
}
export async function rateLimit(env: Env, role: 'upload' | 'admin', now = Date.now()) {
  const window = Math.floor(now / 60000);
  const row = await env.DB.prepare(`INSERT INTO rate_windows(role, window, requests) VALUES (?, ?, 1)
    ON CONFLICT(role) DO UPDATE SET window = excluded.window,
      requests = CASE WHEN rate_windows.window = excluded.window THEN rate_windows.requests + 1 ELSE 1 END
    RETURNING requests`).bind(role, window).first<{ requests: number }>();
  if (!row || row.requests > (role === 'upload' ? 30 : 60)) throw new HttpError(429, 'rate_limited');
}
export async function acquireLease(env: Env, token: string, now: number) {
  const row = await env.DB.prepare(`INSERT INTO delivery_lease(id, token, expires) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires = excluded.expires
    WHERE delivery_lease.expires <= ? RETURNING token`).bind(token, now + 120000, now).first<{token:string}>();
  return row?.token === token;
}
export async function renewLease(env: Env, token: string, now: number) {
  const r = await env.DB.prepare(`UPDATE delivery_lease SET expires = ?
    WHERE id = 1 AND token = ? AND expires > ? RETURNING token`)
    .bind(now + 120000, token, now).first<{token:string}>();
  return r?.token === token;
}
export async function releaseLease(env: Env, token: string) {
  await env.DB.prepare('DELETE FROM delivery_lease WHERE id = 1 AND token = ?').bind(token).run();
}
export async function cleanup(env: Env, now = Date.now()) {
  await env.DB.prepare(`UPDATE batches SET envelope = NULL, payload_bytes = 0
    WHERE state = 'archived' AND envelope IS NOT NULL AND archived_at < ?`)
    .bind(new Date(now - 7 * 86400000).toISOString()).run();
}
export async function recordUpload(env: Env) {
  await env.DB.prepare(`INSERT INTO upload_health(id, last_upload_at) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET last_upload_at = MAX(upload_health.last_upload_at, excluded.last_upload_at)`)
    .bind(new Date().toISOString()).run();
}
export async function status(env: Env) {
  const summary = await env.DB.prepare(`SELECT COUNT(*) AS receipts,
    COALESCE(SUM(CASE WHEN state = 'queued' OR state = 'retrying' THEN 1 ELSE 0 END), 0) AS pending,
    COALESCE(SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
    COALESCE(SUM(payload_bytes), 0) AS payload_bytes,
    MIN(CASE WHEN state != 'archived' THEN received_at END) AS oldest_unarchived,
    MAX(received_at) AS last_accepted,
    MAX(archived_at) AS last_archived,
    (SELECT last_upload_at FROM upload_health WHERE id = 1) AS last_upload
    , (SELECT not_before FROM delivery_backoff WHERE id = 1) AS delivery_not_before
    FROM batches`).first();
  const s = summary as Record<string, unknown>;
  const now = Date.now();
  return { ...s, health: {
    delivery_attention_required: Number(s.failed) > 0 ||
      (typeof s.oldest_unarchived === 'string' && now - Date.parse(s.oldest_unarchived) > 86400000),
    upload_stale: typeof s.last_upload !== 'string' || now - Date.parse(s.last_upload) > 14 * 86400000,
  }};
}
