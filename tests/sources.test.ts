import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBatch, getUploadSource } from '../src/sources.ts';
import { appleHealth, normalize } from '../src/sources/apple-health.ts';
import { canonical, sha256 } from '../src/json.ts';
import { accept, receipt } from '../src/store.ts';
import { deliver } from '../src/deliver.ts';
import { handle } from '../src/index.ts';
import type { SourceAdapter } from '../src/types.ts';
import { commitSha, environment, workout } from './helpers.ts';

const zone = 'America/Los_Angeles';
const receivedAt = '2026-10-20T12:00:00.000Z';

test('Apple Health keeps its existing batch identity, archive bytes and route', async () => {
  const input = { workouts: [workout()] };
  const old = normalize(input, zone);
  const id = await sha256(canonical({ schema_version: old.schema_version,
    normalization_version: old.normalization_version, timezone_assumed: zone, ...old.input }));
  const envelope = canonical({ batch_id: id, received_at: receivedAt,
    schema_version: old.schema_version, normalization_version: old.normalization_version,
    timezone_assumed: zone, warnings: old.warnings, workouts: old.workouts });
  const batch = await createBatch(appleHealth, appleHealth.normalize(input, zone), receivedAt);
  assert.equal(batch.id, id);
  assert.equal(batch.envelope, envelope);
  assert.equal(batch.archive_hash, await sha256(envelope));
  assert.equal(batch.archive_path, `files/apple_health/actions/batches/${id}.json`);
  assert.equal(batch.source, 'apple_health');
  assert.equal(batch.record_count, 1);
  assert.equal(getUploadSource('/v1/workout-batches'), appleHealth);
  assert.equal(getUploadSource('/v1/unknown-batches'), undefined);
});

// A synthetic non-workout adapter exercises the shared pipeline without exposing
// a second production upload source or accepting arbitrary client-selected paths.
const notes: SourceAdapter = {
  id: 'notes', uploadPath: '/v1/note-batches', archivePrefix: 'files/notes/batches/',
  normalize(input) {
    return { recordCount: 2, identity: { entries: input },
      payload: { schema_version: 1, entries: input } };
  },
};

test('new sources namespace batch IDs and exclude receipt time from identity', async () => {
  const result = notes.normalize(['first', 'second'], zone);
  const first = await createBatch(notes, result, receivedAt);
  const later = await createBatch(notes, result, '2026-10-21T12:00:00.000Z');
  const other = await createBatch({ ...notes, id: 'other_notes' }, result, receivedAt);
  assert.equal(first.id, later.id);
  assert.notEqual(first.archive_hash, later.archive_hash);
  assert.notEqual(first.id, other.id);
});

test('non-workout batches use generic storage, receipts and persisted archive routing', async () => {
  const { env, sql } = environment();
  try {
    const batch = await createBatch(notes, notes.normalize(['first', 'second'], zone), receivedAt);
    const saved = await accept(env, batch);
    assert.equal(saved.source, 'notes');
    assert.equal(saved.record_count, 2);
    assert.equal(saved.archive_path, `files/notes/batches/${batch.id}.json`);
    assert.equal('workout_count' in receipt(saved), false);
    const admin = { Authorization: `Bearer ${env.ADMIN_TOKEN}` };
    const getReceipt = () => handle(new Request(`https://uploader.example/v1/batches/${batch.id}`,
      { headers: admin }), env);
    assert.deepEqual(await (await getReceipt()).json(), receipt(saved));
    assert.equal((await handle(new Request(`https://uploader.example/v1/workout-batches/${batch.id}`,
      { headers: admin }), env)).status, 404);
    // Unregistered adapters are never exposed as production HTTP upload routes.
    assert.equal((await handle(new Request(`https://uploader.example${notes.uploadPath}`,
      { method: 'POST', headers: { Authorization: `Bearer ${env.UPLOAD_TOKEN}` } }), env)).status, 404);

    let puts = 0;
    const result = await deliver(env, async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/example/private-vault') return Response.json({ private: true });
      assert.equal(url.pathname, `/repos/example/private-vault/contents/${saved.archive_path}`);
      if (init?.method !== 'PUT') return new Response('', { status: 404 });
      const body = JSON.parse(String(init.body));
      assert.equal(body.message, 'Archive notes batch');
      const archive = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      assert.deepEqual(archive.entries, ['first', 'second']);
      assert.equal(archive.workouts, undefined);
      puts++;
      return Response.json({ commit: { sha: commitSha } }, { status: 201 });
    });
    assert.deepEqual(result, { busy: false, archived: 1, failed: 0 });
    assert.equal(puts, 1);
    const final = await (await getReceipt()).json();
    assert.equal(final.status, 'archived');
    assert.equal(final.source, 'notes');
    assert.equal(final.record_count, 2);
    assert.equal((await accept(env, batch)).state, 'archived');
  } finally { sql.close(); }
});
