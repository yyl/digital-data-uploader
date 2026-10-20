import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Env } from '../src/types.ts';

// Execute production SQL against real SQLite. A small D1-shaped adapter is used
// only to bridge the local SQL API; Worker runtime coverage lives in smoke tests.
export function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_inbox.sql', import.meta.url), 'utf8'));
  const db = { prepare(query: string) {
    const stmt = sql.prepare(query);
    let args: any[] = [];
    const prepared = {
      bind(...values: any[]) { args = values; return prepared; },
      async first() { return stmt.get(...args) ?? null; },
      async run() { const result = stmt.run(...args); return { success: true, meta: { changes: Number(result.changes) }, results: [] }; },
      async all() { return { success: true, results: stmt.all(...args) }; },
    };
    return prepared;
  }};
  return { sql, db: db as unknown as D1Database };
}
export function environment() {
  const { sql, db } = database();
  const env: Env = { DB: db, UPLOAD_TOKEN: 'u'.repeat(40), ADMIN_TOKEN: 'a'.repeat(40),
    GITHUB_TOKEN: 'fake-github-secret', GITHUB_OWNER: 'example', GITHUB_REPO: 'private-vault',
    GITHUB_BRANCH: 'main', ASSUMED_TIMEZONE: 'America/Los_Angeles' };
  return { env, sql };
}
export function workout(changes: Record<string,string> = {}) {
  return { identifier: '00000000-0000-0000-0000-000000000001', type: 'Climbing',
    start_date: 'Oct 15, 2026 at 08:31', end_date: 'Oct 15, 2026 at 09:30',
    duration: '3,488.907 sec', elapsed_time: '3,408.581 sec', energy_burned: '407.883 kcal',
    active_calories: '327.899632035718', average_heart_rate: '125.297759258286',
    average_speed: '', total_distance: '', flights_climbed: '',
    source_name: 'Synthetic Watch', device_name: 'Apple Watch', device_model: 'Watch',
    recording_method: 'Watch', is_from_watch: 'Yes', is_from_third_party: 'No', ...changes };
}
export function upload(env: Env, workouts = [workout()], overrides: RequestInit = {}) {
  return new Request('https://uploader.example/v1/workout-batches', { method: 'POST',
    headers: { Authorization: `Bearer ${env.UPLOAD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workouts }), ...overrides });
}
export const commitSha = 'a'.repeat(40);
