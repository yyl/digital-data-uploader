import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/index.ts';
import { environment, upload, workout } from './helpers.ts';
import { MAX_BYTES } from '../src/types.ts';

test('accepts durably, deduplicates retries and exposes metadata only to admin', async () => {
  const { env, sql } = environment();
  const r = await handle(upload(env), env);
  assert.equal(r.status, 202); assert.equal(r.headers.get('cache-control'), 'no-store');
  const receipt = await r.json();
  assert.equal(receipt.status, 'queued');
  const saved = sql.prepare('SELECT * FROM batches').get()!;
  assert.equal(saved.id, receipt.batch_id); assert.ok(saved.envelope);
  assert.equal((await (await handle(upload(env), env)).json()).received_at, receipt.received_at);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM batches').get()!.n, 1);
  const url = `https://uploader.example/v1/workout-batches/${receipt.batch_id}`;
  assert.equal((await handle(new Request(url, { headers: { Authorization: `Bearer ${env.UPLOAD_TOKEN}` } }), env)).status, 401);
  const admin = await handle(new Request(url, { headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } }), env);
  assert.equal(admin.status, 200); assert.equal((await admin.text()).includes('Climbing'), false);
  sql.close();
});
test('unauthorized, unconfigured and invalid input never enters inbox', async () => {
  const { env, sql } = environment();
  assert.equal((await handle(upload(env, undefined, { headers: {} }), env)).status, 401);
  assert.equal((await handle(upload(env), { ...env, ADMIN_TOKEN: env.UPLOAD_TOKEN })).status, 503);
  assert.equal((await handle(upload(env, [workout(), workout()]), env)).status, 422);
  assert.equal((await handle(upload(env, [], { body: '{bad' }), env)).status, 400);
  assert.equal((await handle(upload(env, [], { headers: { Authorization: `Bearer ${env.UPLOAD_TOKEN}`, 'Content-Type':'text/plain' } }), env)).status, 415);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM batches').get()!.n, 0);
  sql.close();
});
test('body limit applies to actual bytes without Content-Length, empty list is no-op', async () => {
  const { env, sql } = environment();
  assert.equal((await handle(upload(env, [], { body: ' '.repeat(MAX_BYTES + 1) }), env)).status, 413);
  assert.equal((await handle(upload(env, []), env)).status, 200);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM batches').get()!.n, 0);
  sql.close();
});
test('authenticated uploads are rate limited', async () => {
  const { env, sql } = environment();
  for (let i = 0; i < 30; i++) assert.equal((await handle(upload(env, []), env)).status, 200);
  const r = await handle(upload(env, []), env);
  assert.equal(r.status, 429); assert.equal(r.headers.get('Retry-After'), '60');
  sql.close();
});
test('capacity rejection preserves existing batches and retries', async () => {
  const { env, sql } = environment();
  const first = await (await handle(upload(env), env)).json();
  sql.prepare('UPDATE batches SET payload_bytes = ?').run(32 * 1024 * 1024);
  assert.equal((await handle(upload(env, [workout({ identifier: '00000000-0000-0000-0000-000000000002' })]), env)).status, 503);
  assert.equal((await (await handle(upload(env), env)).json()).batch_id, first.batch_id);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM batches').get()!.n, 1);
  sql.close();
});
test('D1 failures return sanitized error without claiming acceptance', async () => {
  const { env, sql } = environment();
  sql.exec('DROP TABLE batches');
  const r = await handle(upload(env), env);
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'internal_error' });
  sql.close();
});

test('empty and identical uploads refresh health without creating duplicate receipts', async () => {
  const {env,sql}=environment();
  const status=async()=>await(await handle(new Request('https://uploader.example/v1/status',{
    headers:{Authorization:`Bearer ${env.ADMIN_TOKEN}`},
  }),env)).json();
  assert.equal((await status()).health.upload_stale,true);
  await handle(upload(env,[]),env);
  assert.equal((await status()).health.upload_stale,false);
  await handle(upload(env),env);
  sql.prepare('UPDATE upload_health SET last_upload_at=?').run('2020-01-01T00:00:00.000Z');
  assert.equal((await status()).health.upload_stale,true);
  await handle(upload(env),env);
  assert.equal((await status()).health.upload_stale,false);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM batches').get()!.n,1);
  sql.close();
});
