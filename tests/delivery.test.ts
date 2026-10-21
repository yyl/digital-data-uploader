import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/index.ts';
import { deliver } from '../src/deliver.ts';
import { archive, toBase64 } from '../src/github.ts';
import { acquireLease, renewLease, releaseLease, cleanup } from '../src/store.ts';
import { sha256 } from '../src/json.ts';
import { environment, upload, workout, commitSha } from './helpers.ts';
import type { Batch } from '../src/types.ts';
import type { Fetch } from '../src/github.ts';

async function queued() {
  const fixture = environment();
  await handle(upload(fixture.env), fixture.env);
  const b = fixture.sql.prepare('SELECT * FROM batches').get() as unknown as Batch;
  return { ...fixture, b };
}
const created = () => Response.json({ commit: { sha: commitSha } }, { status: 201 });

test('delivers only immutable summary file, then records real commit SHA', async () => {
  const { env, sql, b } = await queued();
  const calls: string[] = [];
  const request: Fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/repos/example/private-vault')) return Response.json({private:true});
    calls.push(url);
    assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer fake-github-secret');
    if (!init?.method) return new Response('', { status: 404 });
    assert.equal(init.method, 'PUT');
    assert.ok(url.endsWith(`/files/apple_health/actions/batches/${b.id}.json`));
    const body = JSON.parse(String(init.body));
    assert.equal(body.branch, 'main');
    assert.equal(body.sha, undefined); // create-only: never update unexpected contents
    assert.equal(body.content, toBase64(b.envelope!));
    return created();
  };
  assert.deepEqual(await deliver(env, request), { busy: false, archived: 1, failed: 0 });
  const saved = sql.prepare('SELECT * FROM batches').get()!;
  assert.equal(saved.state, 'archived'); assert.equal(saved.commit_sha, commitSha);
  assert.equal(calls.length, 2);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM delivery_lease').get()!.n, 0);
  sql.close();
});
test('outage preserves payload and retries with backoff without losing later uploads', async () => {
  const { env, sql, b } = await queued();
  const request: Fetch = async () => new Response('', { status: 503 });
  const result = await deliver(env, request); assert.equal(result.failed, 1);
  const saved = sql.prepare('SELECT * FROM batches').get()!;
  assert.equal(saved.state, 'retrying'); assert.equal(saved.envelope, b.envelope);
  assert.ok(Number(saved.next_attempt) > Date.now());
  await handle(upload(env, [workout({ identifier: '00000000-0000-0000-0000-000000000002' })]), env);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM batches').get()!.n, 2);
  sql.close();
});
test('401 becomes visible failed receipt; manual retry can reset configuration failures', async () => {
  const { env, sql } = await queued();
  await deliver(env, async () => new Response('', { status: 401 }));
  const saved = sql.prepare('SELECT * FROM batches').get()!;
  assert.equal(saved.state, 'failed'); assert.equal(saved.last_error, 'github_access_denied');
  assert.equal(saved.attempts, 1);
  assert.deepEqual(await deliver(env, async () => { throw new Error('must not call'); }), { busy:false, archived:0, failed:0 });
  sql.close();
});
test('rate-limit retry-after is respected', async () => {
  const { env, sql } = await queued();
  await deliver(env, async () => new Response('', { status: 429, headers: { 'Retry-After':'600' } }));
  const saved = sql.prepare('SELECT * FROM batches').get()!;
  assert.equal(saved.last_error, 'github_rate_limited');
  assert.ok(Number(saved.next_attempt) > Date.now() + 599000);
  sql.close();
});
test('crash after PUT is recovered by verifying content and fetching commit, without overwrite', async () => {
  const { env, sql, b } = await queued();
  const methods: string[] = [];
  const request: Fetch = async (input, init) => {
    if (String(input).endsWith('/repos/example/private-vault')) return Response.json({private:true});
    methods.push(init?.method ?? 'GET');
    if (String(input).includes('/commits?')) return Response.json([{ sha: commitSha }]);
    return Response.json({ type: 'file', encoding: 'base64', content: toBase64(b.envelope!), sha: 'blob-not-commit' });
  };
  assert.equal(await archive(env, b, request), commitSha);
  assert.deepEqual(methods, ['GET','GET']);
  sql.close();
});
test('unexpected existing content is never overwritten', async () => {
  const { env, sql } = await queued();
  let calls = 0;
  const request: Fetch = async (url) => { if (String(url).endsWith('/repos/example/private-vault')) return Response.json({private:true}); calls++; return Response.json({ type:'file', encoding:'base64', content:toBase64('unexpected') }); };
  await deliver(env, request);
  assert.equal(calls, 1);
  const saved = sql.prepare('SELECT * FROM batches').get()!;
  assert.equal(saved.state, 'failed'); assert.equal(saved.last_error, 'archive_content_conflict');
  sql.close();
});
test('branch conflict on create is retryable', async () => {
  const { env, sql } = await queued();
  await deliver(env, async (url, init) => String(url).endsWith('/repos/example/private-vault') ? Response.json({private:true}) : new Response('', { status:init?.method === 'PUT' ? 409 : 404 }));
  assert.equal(sql.prepare('SELECT state FROM batches').get()!.state, 'retrying');
  sql.close();
});
test('missing pending payload is failed, not acknowledged', async () => {
  const { env, sql } = await queued();
  sql.exec('UPDATE batches SET envelope = NULL');
  await deliver(env, async () => { throw new Error('must not call'); });
  assert.equal(sql.prepare('SELECT state FROM batches').get()!.state, 'failed');
  sql.close();
});
test('lease serializes consumers and stale release cannot clear new owner', async () => {
  const { env, sql } = environment();
  assert.equal(await acquireLease(env,'first',0), true);
  assert.equal(await acquireLease(env,'second',1), false);
  assert.equal(await acquireLease(env,'second',120001), true);
  assert.equal(await renewLease(env,'first',120002), false);
  await releaseLease(env,'first');
  assert.equal(sql.prepare('SELECT token FROM delivery_lease').get()!.token, 'second');
  sql.close();
});
test('overlapping delivery runs cannot both send; future retry timestamps are skipped', async () => {
  const { env, sql } = await queued();
  await acquireLease(env, 'another-owner', Date.now());
  assert.deepEqual(await deliver(env, async () => { throw new Error('must not call'); }), { busy:true, archived:0, failed:0 });
  await releaseLease(env, 'another-owner');
  sql.prepare('UPDATE batches SET next_attempt = ?').run(Date.now() + 100000);
  assert.deepEqual(await deliver(env, async () => { throw new Error('must not call'); }), { busy:false, archived:0, failed:0 });
  sql.close();
});
test('cleanup only scrubs old delivered payloads, leaves receipts and all pending data', async () => {
  const { env, sql, b } = await queued();
  sql.prepare("UPDATE batches SET state='archived', archived_at=?, commit_sha=?").run('2020-01-01T00:00:00.000Z',commitSha);
  await handle(upload(env,[workout({identifier:'00000000-0000-0000-0000-000000000002'})]),env);
  await cleanup(env);
  const archived = sql.prepare('SELECT * FROM batches WHERE id=?').get(b.id)!;
  assert.equal(archived.envelope,null); assert.equal(archived.payload_bytes,0);
  assert.equal(archived.archive_hash, await sha256(b.envelope!));
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM batches WHERE state='queued' AND envelope IS NOT NULL").get()!.n,1);
  const retry = await (await handle(upload(env),env)).json();
  assert.equal(retry.status,'archived'); assert.equal(retry.commit_sha,commitSha);
  sql.close();
});
test('invalid GitHub JSON becomes a sanitized retryable error', async () => {
  const { env, sql } = await queued();
  await deliver(env, async () => new Response('secret-service-error', {status:200}));
  assert.equal(sql.prepare('SELECT last_error FROM batches').get()!.last_error, 'github_invalid_response');
  sql.close();
});

test('public destination is rejected before any workout content is sent', async () => {
  const {env,sql} = await queued(); let puts = 0;
  await deliver(env, async (_url,init) => { if(init?.method==='PUT') puts++; return Response.json({private:false}); });
  assert.equal(puts,0);
  assert.equal(sql.prepare('SELECT last_error FROM batches').get()!.last_error,'destination_not_private');
  sql.close();
});
test('redirects never forward credentials to another host', async () => {
  const {env,sql}=await queued();
  await deliver(env,async ()=>new Response('',{status:302,headers:{Location:'https://other.example'}}));
  assert.equal(sql.prepare('SELECT last_error FROM batches').get()!.last_error,'github_unexpected_redirect');
  sql.close();
});
test('invalid rate-limit headers still produce a finite retry time', async () => {
  const {env,sql}=await queued();
  await deliver(env,async ()=>new Response('',{status:429,headers:{'Retry-After':'invalid'}}));
  const row=sql.prepare('SELECT * FROM batches').get()!;
  assert.equal(row.state,'retrying');assert.ok(Number.isFinite(row.next_attempt));
  sql.close();
});

test('GitHub cooldown applies to all queued batches and survives manual retry', async () => {
  const {env,sql}=await queued();
  await handle(upload(env,[workout({identifier:'00000000-0000-0000-0000-000000000002'})]),env);
  let calls=0;
  const request: Fetch = async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'86400'}});};
  await deliver(env,request);assert.equal(calls,1);
  const next=await deliver(env,request);assert.equal(calls,1);
  assert.ok('retry_after' in next);
  const manual=await handle(new Request('https://uploader.example/v1/admin/retry',{
    method:'POST',headers:{Authorization:`Bearer ${env.ADMIN_TOKEN}`},
  }),env);
  assert.equal(manual.status,200);assert.ok((await manual.json()).retry_after);
  assert.equal(calls,1);
  sql.prepare('UPDATE delivery_backoff SET not_before=0').run();
  await deliver(env,request);assert.equal(calls,2);
  sql.close();
});
