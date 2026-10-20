import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseDate, canonical, sha256 } from '../src/normalize.ts';
import { workout } from './helpers.ts';
const zone = 'America/Los_Angeles';

test('normalizes all 18 raw fields without inventing unavailable data', () => {
  const result = normalize({ workouts: [workout()] }, zone);
  const w = result.workouts[0]!;
  assert.equal(Object.keys(w.raw).length, 18);
  assert.equal(w.normalized.duration_seconds, 3488.907);
  assert.equal(w.normalized.elapsed_seconds, 3408.581);
  assert.equal(w.normalized.start.utc, '2026-10-15T15:31:00.000Z');
  assert.equal(w.normalized.end.timestamp_precision, 'minute');
  assert.equal(w.normalized.energy_burned?.interpretation, 'unverified');
  assert.equal(w.normalized.total_distance, null);
  assert.equal(w.normalized.is_from_third_party, false);
  assert.deepEqual(w.raw, workout());
});
test('winter uses PST, spring gaps and autumn folds remain unresolved', () => {
  assert.equal(parseDate('Jan 10, 2026 at 08:00', zone, 'date').normalized.utc, '2026-01-10T16:00:00.000Z');
  assert.equal(parseDate('Mar 8, 2026 at 02:30', zone, 'date').normalized.resolution, 'nonexistent');
  assert.equal(parseDate('Nov 1, 2026 at 01:30', zone, 'date').normalized.resolution, 'ambiguous');
  assert.equal(parseDate('Nov 1, 2026 at 01:30', zone, 'date').normalized.utc, null);
});
test('accepts empty optional fields and retains zeros', () => {
  const r = normalize({ workouts: [workout({ average_heart_rate: '', active_calories: '0' })] }, zone).workouts[0]!;
  assert.equal(r.normalized.average_heart_rate, null);
  assert.equal(r.normalized.active_calories?.value, 0);
});
test('rejects invalid shapes, duplicates, unknown or malformed fields atomically', () => {
  for (const input of [null, [], { workouts: '[]' }, { workouts: [], records: [] },
    { workouts: [workout(), workout()] }, { workouts: [workout({ extra: 'x' })] },
    { workouts: [workout({ identifier: '../bad' })] },
    { workouts: [workout({ start_date: 'Feb 30, 2026 at 08:00' })] },
    { workouts: [workout({ start_date: 'Oct 15, 2026 at 24:00' })] },
    { workouts: [workout({ end_date: 'Oct 14, 2026 at 09:00' })] },
    { workouts: [workout({ duration: '3,48.9 sec' })] },
    { workouts: [workout({ energy_burned: '400 kJ' })] },
    { workouts: [workout({ active_calories: '-1' })] },
    { workouts: [workout({ average_heart_rate: 'Infinity' })] },
    { workouts: [workout({ is_from_watch: 'true' })] },
    { workouts: [workout({ flights_climbed: '1.2' })] },
    { workouts: [workout({ source_name: 'secret\nnewline' })] },
  ]) assert.throws(() => normalize(input, zone));
});
test('canonicalizes serialization and workout order, keeps changed observations distinct', async () => {
  const a = workout(), b = workout({ identifier: '00000000-0000-0000-0000-000000000002' });
  const reversed = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(canonical(normalize({ workouts: [a,b] }, zone).input), canonical(normalize({ workouts: [b,reversed] }, zone).input));
  assert.notEqual(await sha256(canonical(a)), await sha256(canonical({ ...a, duration: '12 sec' })));
});
test('rejects more than 100 workouts', () => {
  assert.throws(() => normalize({ workouts: Array.from({ length: 101 }, () => workout()) }, zone), { status: 413 });
});
