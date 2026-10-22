import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from 'miniflare';
import { workout, commitSha } from './helpers.ts';

const uploadToken = 'u'.repeat(40), adminToken = 'a'.repeat(40);
const files = new Map<string,string>();
let githubDown = false, rateLimited = false, puts = 0;
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: '.wrangler/build/index.js', compatibilityDate: '2026-10-16',
  d1Databases: ['DB'], bindings: { UPLOAD_TOKEN:uploadToken, ADMIN_TOKEN:adminToken,
    GITHUB_TOKEN:'synthetic', GITHUB_OWNER:'example', GITHUB_REPO:'private-vault',
    GITHUB_BRANCH:'main', ASSUMED_TIMEZONE:'America/Los_Angeles' },
  outboundService: async (request) => {
    assert.equal(new URL(request.url).hostname, 'api.github.com');
    if (githubDown) return new MFResponse('',{status:503});
    if (rateLimited) return new MFResponse('',{status:429,headers:{'Retry-After':'600'}});
    const url = new URL(request.url);
    if (url.pathname === '/repos/example/private-vault') return MFResponse.json({private:true});
    if (url.pathname.endsWith('/commits')) return MFResponse.json([{sha:commitSha}]);
    if (request.method === 'PUT') {
      const body = await request.json() as {content:string};
      files.set(url.pathname,body.content); puts++;
      return MFResponse.json({commit:{sha:commitSha}}, {status:201});
    }
    const content = files.get(url.pathname);
    return content ? MFResponse.json({type:'file',encoding:'base64',content,sha:'b'.repeat(40)}) : new MFResponse('',{status:404});
  },
}));
try {
  const db = await mf.getD1Database('DB');
  const migration = readFileSync(new URL('../migrations/0001_inbox.sql',import.meta.url),'utf8');
  await db.batch(migration.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  const headers = {Authorization:`Bearer ${uploadToken}`,'Content-Type':'application/json'};
  const send = (items = [workout()]) => mf.dispatchFetch('https://uploader.test/v1/workout-batches',{
    method:'POST',headers,body:JSON.stringify({workouts:items}),
  });
  const first = await send(); assert.equal(first.status,202);
  const receipt = await first.json() as {batch_id:string,source:string,record_count:number};
  assert.equal(receipt.source,'apple_health'); assert.equal(receipt.record_count,1);
  const stored = (await db.prepare('SELECT source,record_count,archive_path FROM batches').first())!;
  assert.equal(stored.source,'apple_health'); assert.equal(stored.record_count,1);
  assert.equal(stored.archive_path,`files/apple_health/actions/batches/${receipt.batch_id}.json`);
  assert.equal((await send()).status,202);
  const retry = () => mf.dispatchFetch('https://uploader.test/v1/admin/retry',{
    method:'POST',headers:{Authorization:`Bearer ${adminToken}`},
  });
  githubDown = true;
  assert.equal((await retry()).status,200);
  assert.equal((await db.prepare('SELECT state FROM batches').first())!.state,'retrying');
  githubDown = false;
  const delivered = await (await retry()).json() as {archived:number};
  if (delivered.archived !== 1) console.log('Delivery diagnostic', delivered, await db.prepare('SELECT state,last_error,attempts FROM batches').first());
  assert.equal(delivered.archived,1); assert.equal(puts,1);
  assert.equal((await send()).status,200); assert.equal(puts,1);
  const r = await mf.dispatchFetch(`https://uploader.test/v1/batches/${receipt.batch_id}`,{
    headers:{Authorization:`Bearer ${adminToken}`},
  });
  const final = await r.json() as {status:string,commit_sha:string};
  assert.equal(final.status,'archived'); assert.equal(final.commit_sha,commitSha);
  assert.ok(files.has(`/repos/example/private-vault/contents/${stored.archive_path}`));
  const archive = JSON.parse(Buffer.from([...files.values()][0]!,'base64').toString('utf8'));
  assert.equal(archive.workouts[0].raw.duration,'3,488.907 sec');
  assert.equal(archive.workouts[0].normalized.start.utc,'2026-10-15T15:31:00.000Z');
  // 100 actual workouts with different IDs exercise maximum count in workerd/D1.
  const max = await send(Array.from({length:100},(_,i)=>workout({identifier:`00000000-0000-0000-0000-${String(i+100).padStart(12,'0')}`})));
  assert.equal(max.status,202);
  assert.equal((await max.json() as {record_count:number}).record_count,100);
  rateLimited = true; await retry();
  assert.ok((await db.prepare('SELECT not_before FROM delivery_backoff').first())!.not_before > Date.now());
  rateLimited = false;
  assert.ok((await (await retry()).json() as {retry_after:string}).retry_after);
  await db.prepare('UPDATE delivery_backoff SET not_before=0').run();
  assert.equal((await (await retry()).json() as {archived:number}).archived,1);
  assert.equal(puts,2);
  const csv = '\uFEFFDate,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds\r\n2026-10-20 08:00:00,Morning,45m,Squat,1,60,8,0,0\r\n';
  const strong = (body = csv, type = 'text/csv') => mf.dispatchFetch('https://uploader.test/v1/strong-export', {
    method:'POST', headers:{Authorization:`Bearer ${uploadToken}`,'Content-Type':type}, body,
  });
  const before = await db.prepare('SELECT COUNT(*) n FROM batches').first();
  const health = await db.prepare('SELECT last_upload_at FROM upload_health').first();
  assert.equal((await strong()).status,200);
  assert.equal(puts,3);
  const strongPath = '/repos/example/private-vault/contents/files/strong_workouts.csv';
  assert.equal(Buffer.from(files.get(strongPath)!,'base64').toString('utf8'),csv);
  assert.equal((await (await strong()).json() as {status:string}).status,'unchanged');
  const wrongType = await strong(csv, 'application/vnd.ms-excel');
  assert.equal(wrongType.status,415);
  assert.deepEqual(await wrongType.json(),{error:'expected_csv'});
  assert.equal(puts,3);
  const changed = csv.replace(',60,8,',',70,8,');
  assert.equal((await strong(changed)).status,200);
  assert.equal(puts,4);
  assert.equal(Buffer.from(files.get(strongPath)!,'base64').toString('utf8'),changed);
  const wrapped = await strong(JSON.stringify({csv}), 'application/json');
  assert.equal(wrapped.status,415);
  assert.equal(puts,4);
  githubDown = true;
  assert.equal((await strong()).status,503);
  githubDown = false;
  assert.equal(Buffer.from(files.get(strongPath)!,'base64').toString('utf8'),changed);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM batches').first())!.n,before!.n);
  assert.equal((await db.prepare('SELECT last_upload_at FROM upload_health').first())!.last_upload_at,health!.last_upload_at);
  console.log('Strong integration passed: raw CSV create, overwrite, BOM preservation, strict text/csv, JSON rejection, identical no-op and visible outage without inbox or Apple Health health writes.');
  console.log('Worker/D1 integration passed: durable upload, outage, retry, GitHub archive, duplicate receipt, 100-workout batch, and shared rate-limit cooldown. All GitHub traffic mocked.');
} finally { await mf.dispose(); }
