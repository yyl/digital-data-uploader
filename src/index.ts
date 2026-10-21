import type { Env } from './types.ts';
import { HttpError, MAX_BYTES } from './types.ts';
import { sha256 } from './json.ts';
import { createBatch, getUploadSource } from './sources.ts';
import { accept, getBatch, rateLimit, receipt, status, recordUpload } from './store.ts';
import { deliver } from './deliver.ts';

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
}
function checkConfig(env: Env) {
  if (!env.UPLOAD_TOKEN || !env.ADMIN_TOKEN || env.UPLOAD_TOKEN.length < 32 || env.ADMIN_TOKEN.length < 32 ||
      env.UPLOAD_TOKEN === env.ADMIN_TOKEN || !env.GITHUB_TOKEN ||
      !/^[A-Za-z0-9-]+$/.test(env.GITHUB_OWNER) || env.GITHUB_OWNER === 'REPLACE_OWNER' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(env.GITHUB_REPO) || !env.GITHUB_BRANCH || !env.DB) {
    throw new HttpError(503, 'service_not_configured');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: env.ASSUMED_TIMEZONE || 'America/Los_Angeles' }); }
  catch { throw new HttpError(503, 'service_not_configured'); }
}
async function authenticate(request: Request, env: Env, role: 'upload' | 'admin') {
  const expected = role === 'admin' ? env.ADMIN_TOKEN : env.UPLOAD_TOKEN;
  const provided = request.headers.get('Authorization') ?? '';
  if (provided.length > 1024) throw new HttpError(401, 'unauthorized');
  const actualHash = await sha256(provided), expectedHash = await sha256(`Bearer ${expected}`);
  let diff = 0;
  for (let i = 0; i < actualHash.length; i++) diff |= actualHash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  if (diff) throw new HttpError(401, 'unauthorized');
  await rateLimit(env, role);
}
async function body(request: Request) {
  if ((request.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'expected_application_json');
  }
  if (request.headers.has('Content-Encoding') && request.headers.get('Content-Encoding') !== 'identity') {
    throw new HttpError(415, 'unsupported_content_encoding');
  }
  const claimed = request.headers.get('Content-Length');
  if (claimed && (!/^\d+$/.test(claimed) || Number(claimed) > MAX_BYTES)) throw new HttpError(413, 'body_too_large');
  if (!request.body) throw new HttpError(400, 'invalid_json');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 10000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new HttpError(408, 'body_read_timeout');
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new HttpError(413, 'body_too_large'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'body_read_failed');
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer)); }
  catch { throw new HttpError(400, 'invalid_json'); }
}
export async function handle(request: Request, env: Env) {
  try {
    checkConfig(env);
    const url = new URL(request.url);
    if (url.search) throw new HttpError(400, 'query_not_supported');
    const source = getUploadSource(url.pathname);
    if (source && request.method === 'POST') {
      await authenticate(request, env, 'upload');
      const zone = env.ASSUMED_TIMEZONE || 'America/Los_Angeles';
      const result = source.normalize(await body(request), zone);
      if (!result.recordCount) {
        await recordUpload(env);
        return reply({ status: 'empty', source: source.id, record_count: 0 });
      }
      const batch = await createBatch(source, result);
      const existing = await getBatch(env, batch.id);
      if (existing) {
        await recordUpload(env);
        return reply(receipt(existing), existing.state === 'archived' ? 200 : 202);
      }
      const b = await accept(env, batch);
      await recordUpload(env);
      return reply(receipt(b), 202);
    }
    // Receipt/status/admin routes require the separate administrator token.
    if (url.pathname === '/v1/status' && request.method === 'GET') {
      await authenticate(request, env, 'admin');
      return reply(await status(env));
    }
    const match = /^\/v1\/(batches|workout-batches)\/([a-f0-9]{64})$/.exec(url.pathname);
    if (match && request.method === 'GET') {
      await authenticate(request, env, 'admin');
      const b = await getBatch(env, match[2]!);
      if (!b || (match[1] === 'workout-batches' && b.source !== 'apple_health')) throw new HttpError(404, 'batch_not_found');
      return reply(receipt(b));
    }
    if (url.pathname === '/v1/admin/retry' && request.method === 'POST') {
      await authenticate(request, env, 'admin');
      await env.DB.prepare(`UPDATE batches SET state = 'queued', next_attempt = 0
        WHERE state IN ('failed', 'retrying')`).run();
      return reply(await deliver(env));
    }
    throw new HttpError(404, 'route_not_found');
  } catch (error) {
    if (error instanceof HttpError) return reply({ error: error.code, ...(error.field ? { field: error.field } : {}) }, error.status);
    // Never log exceptions from D1 or HTTP clients: they can include SQL bindings,
    // tokens, repository responses, or the uploaded health data.
    console.error('request_failed');
    return reply({ error: 'internal_error' }, 503);
  }
}
export default {
  fetch: handle,
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    try {
      checkConfig(env);
      const result = await deliver(env);
      if (result.failed) console.error('delivery_failed');
      const summary = await status(env);
      if (summary.health.delivery_attention_required) console.warn('delivery_attention_required');
      if (summary.health.upload_stale) console.warn('upload_stale');
    } catch {
      // Mark the invocation failed without letting D1 exceptions reach logs.
      throw new Error('scheduled_delivery_failed');
    }
  },
} satisfies ExportedHandler<Env>;
