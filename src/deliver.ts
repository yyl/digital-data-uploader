import type { Batch, Env } from './types.ts';
import type { Fetch } from './github.ts';
import { archive, DeliveryError } from './github.ts';
import { acquireLease, cleanup, releaseLease, renewLease } from './store.ts';

export async function deliver(env: Env, request: Fetch = fetch) {
  const token = crypto.randomUUID();
  if (!await acquireLease(env, token, Date.now())) return { busy: true, archived: 0, failed: 0 };
  let archived = 0, failed = 0;
  try {
    await cleanup(env);
    const backoff = await env.DB.prepare('SELECT not_before FROM delivery_backoff WHERE id = 1').first<{not_before:number}>();
    if (backoff && backoff.not_before > Date.now()) {
      return { busy: false, archived: 0, failed: 0, retry_after: new Date(backoff.not_before).toISOString() };
    }
    for (let i = 0; i < 3; i++) {
      if (!await renewLease(env, token, Date.now())) break;
      const b = await env.DB.prepare(`SELECT * FROM batches
        WHERE state IN ('queued','retrying') AND next_attempt <= ?
        ORDER BY received_at, id LIMIT 1`).bind(Date.now()).first<Batch>();
      if (!b) break;
      try {
        const sha = await archive(env, b, request);
        // Fence every update: an expired owner cannot mutate a newer lease's work.
        const result = await env.DB.prepare(`UPDATE batches SET state = 'archived',
          attempts = attempts + 1, last_error = NULL, commit_sha = ?, archived_at = ?
          WHERE id = ? AND EXISTS (SELECT 1 FROM delivery_lease WHERE id = 1 AND token = ? AND expires > ?)`)
          .bind(sha, new Date().toISOString(), b.id, token, Date.now()).run();
        archived += result.meta.changes;
      } catch (error) {
        const e = error instanceof DeliveryError ? error : new DeliveryError('delivery_internal_error');
        const delay = Math.max(e.retryAfterMs, Math.min(3_600_000, 60_000 * 2 ** Math.min(b.attempts, 6)));
        if (e.code === 'github_rate_limited') {
          // GitHub limits apply to the destination/token, not just one file.
          // Persist the cooldown so other batches and admin retries respect it.
          await env.DB.prepare(`INSERT INTO delivery_backoff(id, not_before)
            SELECT 1, ? WHERE EXISTS (SELECT 1 FROM delivery_lease WHERE id = 1 AND token = ? AND expires > ?)
            ON CONFLICT(id) DO UPDATE SET not_before = MAX(delivery_backoff.not_before, excluded.not_before)`)
            .bind(Date.now() + delay, token, Date.now()).run();
        }
        await env.DB.prepare(`UPDATE batches SET state = ?, attempts = attempts + 1,
          next_attempt = ?, last_error = ? WHERE id = ? AND EXISTS
          (SELECT 1 FROM delivery_lease WHERE id = 1 AND token = ? AND expires > ?)`)
          .bind(e.permanent ? 'failed' : 'retrying', Date.now() + delay, e.code, b.id, token, Date.now()).run();
        failed++;
        // Access/rate/network failures likely affect every batch. Avoid hammering
        // GitHub and consuming more requests until the next scheduled attempt.
        if (e.code !== 'archive_content_conflict') break;
      }
    }
    return { busy: false, archived, failed };
  } finally { await releaseLease(env, token); }
}
