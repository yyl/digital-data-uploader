import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/index.ts';
import { replaceStrongExport, toBase64 } from '../src/github.ts';
import type { Fetch } from '../src/github.ts';
import { MAX_STRONG_BYTES, STRONG_PATH, readStrongCsv } from '../src/sources/strong.ts';
import { environment, commitSha, upload } from './helpers.ts';

const header = 'Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE';
const csv = `${header}\r\n2026-10-20 08:00:00,"Morning, strength",45m,"Squat (Barbell)",1,60,8,0,0,"Slow\r\nthen \"\"hold\"\" — 好",,8\r\n`;
const blobSha = 'b'.repeat(40);
const route = 'https://uploader.example/v1/strong-export';
function request(env: ReturnType<typeof environment>['env'], body: BodyInit = csv, overrides: RequestInit = {}) {
  return new Request(route, { method: 'POST', body,
    headers: { Authorization: `Bearer ${env.UPLOAD_TOKEN}`, 'Content-Type': 'text/csv' }, ...overrides });
}
const neverFetch: Fetch = async () => { throw new Error('Unexpected GitHub request'); };
function github(initial?: string) {
  let stored = initial, puts = 0;
  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.github.com');
    assert.equal(init?.redirect, 'manual');
    if (url.pathname === '/repos/example/private-vault') return Response.json({ private: true });
    assert.equal(url.pathname, `/repos/example/private-vault/contents/${STRONG_PATH}`);
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      assert.equal(body.branch, 'main');
      assert.equal(body.sha, stored === undefined ? undefined : blobSha);
      stored = Buffer.from(body.content, 'base64').toString('utf8');
      puts++;
      return Response.json({ commit: { sha: commitSha } });
    }
    assert.equal(url.searchParams.get('ref'), 'main');
    return stored === undefined ? new Response('', { status: 404 }) :
      Response.json({ type: 'file', encoding: 'base64', sha: blobSha, content: toBase64(stored) });
  };
  return { fetch, get stored() { return stored; }, get puts() { return puts; } };
}

test('Strong full exports create, replace and deduplicate without inbox or Apple Health health writes', async () => {
  const { env, sql } = environment(), remote = github();
  try {
    const save = (body = csv) => handle(request(env, body), env, remote.fetch);
    assert.deepEqual(await (await save()).json(), {
      status: 'saved', source: 'strong', path: STRONG_PATH, commit_sha: commitSha,
    });
    assert.equal(remote.stored, csv);
    assert.equal(remote.puts, 1);
    const identical = await save();
    assert.equal(identical.status, 200);
    assert.equal(identical.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await identical.json(), { status: 'unchanged', source: 'strong', path: STRONG_PATH });
    assert.equal(remote.puts, 1);
    const replacement = csv.replace(',60,8,', ',70,8,');
    assert.equal((await save(replacement)).status, 200);
    assert.equal(remote.stored, replacement);
    assert.equal(remote.puts, 2);
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM batches').get()!.n, 0);
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM upload_health').get()!.n, 0);
    // Existing JSON ingestion still works alongside direct CSV delivery.
    assert.equal((await handle(upload(env), env)).status, 202);
  } finally { sql.close(); }
});

test('BOM, CRLF, multiline quoted notes and Unicode survive byte-for-byte', async () => {
  const { env, sql } = environment(), remote = github('previous');
  try {
    const original = '\uFEFF' + csv;
    assert.equal((await handle(request(env, original), env, remote.fetch)).status, 200);
    assert.deepEqual(Buffer.from(remote.stored!), Buffer.from(original));
    assert.equal((await (await handle(request(env, original), env, remote.fetch)).json()).status, 'unchanged');
    assert.equal(remote.puts, 1);
  } finally { sql.close(); }
});

test('wrong credentials, paths and methods never write to GitHub', async () => {
  const { env, sql } = environment();
  try {
    for (const token of ['', env.ADMIN_TOKEN]) {
      const response = await handle(request(env, csv, { headers: { Authorization: `Bearer ${token}` } }), env, neverFetch);
      assert.equal(response.status, 401);
    }
    assert.equal((await handle(new Request(route), env, neverFetch)).status, 404);
    const arbitrary = request(env);
    assert.equal((await handle(new Request(arbitrary.url + '?path=other.csv', arbitrary), env, neverFetch)).status, 400);
  } finally { sql.close(); }
});

test('malformed, header-only and truncated CSV cannot replace an existing export', async () => {
  const { env, sql } = environment();
  try {
    for (const invalid of ['', '<html>Login</html>', header, header + '\n',
      csv.slice(0, csv.indexOf('then') + 1), csv.replace(',60,8,', ',60,'),
      csv.replace('Date,', 'Unknown,'), csv.replace('2026-10-20 08:00:00', ''),
      csv.replace('Duration,', 'Date,'), csv.replace('Slow', '\0'), csv.replace('45m', '45"m')]) {
      assert.equal((await handle(request(env, invalid), env, neverFetch)).status, 422);
    }
    assert.equal((await handle(request(env, new Uint8Array([0xff])), env, neverFetch)).status, 400);
    const noBody = new Request(route, { method: 'POST', headers: {
      Authorization: `Bearer ${env.UPLOAD_TOKEN}`, 'Content-Type': 'text/csv',
    } });
    assert.equal((await handle(noBody, env, neverFetch)).status, 400);
  } finally { sql.close(); }
});

test('other or missing MIME types reject even valid CSV before any GitHub write', async () => {
  const { env, sql } = environment();
  try {
    for (const type of ['text/plain', 'application/octet-stream', 'application/vnd.ms-excel',
      'text/comma-separated-values', 'application/csv', 'application/json',
      'multipart/form-data; boundary=abc', 'application/x-www-form-urlencoded',
      'text/csv; charset=utf-8', 'TEXT/CSV', 'text/csvx', '']) {
      const headers: Record<string, string> = { Authorization: `Bearer ${env.UPLOAD_TOKEN}` };
      if (type) headers['Content-Type'] = type;
      // Bytes prevent Request from synthesizing text/plain when the header is missing.
      const response = await handle(request(env, new TextEncoder().encode(csv), { headers }), env, neverFetch);
      assert.equal(response.status, 415);
      assert.deepEqual(await response.json(), { error: 'expected_csv' });
    }
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM batches').get()!.n, 0);
  } finally { sql.close(); }
});

test('JSON wrappers and compressed uploads are rejected even with text/csv', async () => {
  const { env, sql } = environment();
  try {
    assert.equal((await handle(request(env, JSON.stringify({ csv })), env, neverFetch)).status, 422);
    assert.equal((await handle(request(env, csv, { headers: {
      Authorization: `Bearer ${env.UPLOAD_TOKEN}`, 'Content-Type': 'text/csv', 'Content-Encoding': 'gzip',
    } }), env, neverFetch)).status, 415);
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM batches').get()!.n, 0);
  } finally { sql.close(); }
});

test('Strong byte limit covers actual bytes, including a dishonest Content-Length', async () => {
  const { env, sql } = environment();
  try {
    for (const length of [undefined, '1', String(MAX_STRONG_BYTES + 1)]) {
      const headers: Record<string, string> = { Authorization: `Bearer ${env.UPLOAD_TOKEN}`, 'Content-Type': 'text/csv' };
      if (length) headers['Content-Length'] = length;
      assert.equal((await handle(request(env, ' '.repeat(MAX_STRONG_BYTES + 1), { headers }), env, neverFetch)).status, 413);
    }
  } finally { sql.close(); }
});

test('Strong and Apple Health share the upload rate limit', async () => {
  const { env, sql } = environment();
  try {
    for (let i = 0; i < 30; i++) await handle(upload(env, []), env);
    const response = await handle(request(env), env, neverFetch);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '60');
  } finally { sql.close(); }
});

test('GitHub outages are visible, not queued; retry after a lost response is unchanged', async () => {
  const { env, sql } = environment(), remote = github();
  try {
    const response = await handle(request(env), env, async () => { throw new Error('sensitive network details'); });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'github_network_error' });
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM batches').get()!.n, 0);
    let loseResponse = true;
    const fetch: Fetch = async (input, init) => {
      const result = await remote.fetch(input, init);
      if (init?.method === 'PUT' && loseResponse) { loseResponse = false; throw new Error('lost response'); }
      return result;
    };
    assert.equal((await handle(request(env), env, fetch)).status, 503);
    assert.equal((await (await handle(request(env), env, fetch)).json()).status, 'unchanged');
    assert.equal(remote.puts, 1);
  } finally { sql.close(); }
});

test('concurrent file writes return a conflict without retrying stale bytes', async () => {
  const { env, sql } = environment();
  try {
    for (const conflict of [409, 422]) {
      let puts = 0;
      const remote = github('other export');
      const response = await handle(request(env), env, async (input, init) => {
        if (init?.method !== 'PUT') return remote.fetch(input, init);
        puts++;
        assert.equal(JSON.parse(String(init.body)).sha, blobSha);
        return new Response('', { status: conflict });
      });
      assert.equal(response.status, 409);
      assert.equal(puts, 1);
    }
  } finally { sql.close(); }
});

test('public destinations, redirects and unverifiable existing files are never overwritten', async () => {
  const { env, sql } = environment();
  try {
    for (const result of [() => Response.json({ private: false }),
      () => new Response('', { status: 302, headers: { Location: 'https://other.example' } })]) {
      await assert.rejects(replaceStrongExport(env, csv, async (_input, init) => {
        assert.notEqual(init?.method, 'PUT'); return result();
      }));
    }
    for (const info of [{ type: 'dir' }, { type: 'file', encoding: 'base64', content: '', sha: 'invalid' }]) {
      const remote = github();
      await assert.rejects(replaceStrongExport(env, csv, async (input, init) => {
        assert.notEqual(init?.method, 'PUT');
        return String(input).includes('/contents/') ? Response.json(info) : remote.fetch(input, init);
      }));
    }
  } finally { sql.close(); }
});

test('GitHub rate limits and malformed responses return sanitized failures', async () => {
  const { env, sql } = environment();
  try {
    const limited = await handle(request(env), env, async () => new Response('', {
      status: 429, headers: { 'Retry-After': '600' },
    }));
    assert.equal(limited.status, 503);
    assert.deepEqual(await limited.json(), { error: 'github_rate_limited' });
    assert.equal(limited.headers.get('Retry-After'), '600');
    const remote = github();
    const malformed = await handle(request(env), env, async (input, init) => init?.method === 'PUT' ?
      Response.json({ commit: { sha: 'not-a-commit' }, secret: 'sensitive' }) : remote.fetch(input, init));
    assert.equal(malformed.status, 503);
    assert.deepEqual(await malformed.json(), { error: 'github_invalid_response' });
  } finally { sql.close(); }
});

test('validator accepts minimal supported headers, reordered columns and a final row without newline', async () => {
  const minimal = 'Workout Name,Date,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds\nMorning,2026-10-20 08:00:00,45m,Squat,1,60,8,0,0';
  assert.equal(await readStrongCsv(new Request(route, { headers: { 'Content-Type': 'text/csv' } }),
    new TextEncoder().encode(minimal)), minimal);
});
