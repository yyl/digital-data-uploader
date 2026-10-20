import { HttpError, MAX_WORKOUTS, NORMALIZATION_VERSION } from './types.ts';

const FIELDS = new Set([
  'average_speed', 'total_distance', 'start_date', 'is_from_third_party',
  'end_date', 'energy_burned', 'type', 'active_calories', 'identifier',
  'source_name', 'average_heart_rate', 'flights_climbed', 'device_name',
  'recording_method', 'duration', 'elapsed_time', 'is_from_watch', 'device_model',
]);
const REQUIRED = ['identifier', 'type', 'start_date', 'end_date', 'duration'] as const;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = '(?:0|[1-9]\\d*|[1-9]\\d{0,2}(?:,\\d{3})+)(?:\\.\\d+)?';
const formatters = new Map<string, Intl.DateTimeFormat>();
// Bound caches: never retain unbounded dates across Worker requests.
const offsetCache = new Map<string, number[]>();
function invalid(field: string): never { throw new HttpError(422, 'invalid_field', field); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 8) formatters.clear();
    formatters.set(zone, f);
  }
  return f;
}
function wallAt(instant: number, zone: string): number {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(zone).formatToParts(instant)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}
export function parseDate(value: string, zone: string, field: string) {
  const m = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}) at (\d{2}):(\d{2})$/.exec(value);
  if (!m) invalid(field);
  const year = Number(m[3]), month = MONTHS.indexOf(m[1]!), day = Number(m[2]);
  const hour = Number(m[4]), minute = Number(m[5]);
  if (year < 1900 || year > 2200 || hour > 23 || minute > 59) invalid(field);
  const wall = Date.UTC(year, month, day, hour, minute);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month || check.getUTCDate() !== day) invalid(field);
  const cacheKey = `${zone}:${year}-${month}-${day}`;
  let offsets = offsetCache.get(cacheKey);
  if (!offsets) {
    // Sample both sides of transitions, then verify every candidate by round-trip.
    offsets = [...new Set([-36, -24, -12, 0, 12, 24, 36].map(h => {
      const t = Date.UTC(year, month, day, 12) + h * 3_600_000;
      return wallAt(t, zone) - t;
    }))];
    if (offsetCache.size >= 512) offsetCache.clear();
    offsetCache.set(cacheKey, offsets);
  }
  const candidates = offsets.map(offset => wall - offset).filter(t => wallAt(t, zone) === wall).sort();
  return {
    wall,
    normalized: {
      utc: candidates.length === 1 ? new Date(candidates[0]!).toISOString() : null,
      resolution: candidates.length === 1 ? 'assumed_timezone' : candidates.length ? 'ambiguous' : 'nonexistent',
      timezone_assumed: zone,
      timestamp_precision: 'minute',
    },
  };
}
function quantity(value: string | undefined, units: readonly string[], field: string, max = 1e9) {
  if (value === undefined || value === '') return null;
  const m = new RegExp(`^(${NUMBER})(?: ([A-Za-z/]+))?$`).exec(value);
  if (!m) invalid(field);
  const n = Number(m[1]!.replaceAll(',', ''));
  const unit = m[2] ?? '';
  if (!Number.isFinite(n) || n > max || !units.includes(unit)) invalid(field);
  return { value: n, unit };
}
function flag(value: string | undefined, field: string) {
  if (value === undefined || value === '') return null;
  if (value !== 'Yes' && value !== 'No') invalid(field);
  return value === 'Yes';
}
export function normalize(input: unknown, zone: string) {
  formatter(zone); // Configuration errors are not user field errors.
  const root = object(input, 'body');
  if (Object.keys(root).some(k => k !== 'workouts')) invalid('body');
  if (!Array.isArray(root.workouts)) invalid('workouts');
  if (root.workouts.length > MAX_WORKOUTS) throw new HttpError(413, 'too_many_workouts');
  const seen = new Set<string>();
  const rows = root.workouts.map((entry, i) => {
    const path = `workouts[${i}]`, obj = object(entry, path);
    const raw: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!FIELDS.has(k) || typeof v !== 'string' || v.length > 1024 || /[\u0000-\u001f\u007f]/.test(v)) invalid(`${path}.${k}`);
      raw[k] = v;
    }
    for (const k of REQUIRED) if (!raw[k]?.trim()) invalid(`${path}.${k}`);
    if (!UUID.test(raw.identifier!)) invalid(`${path}.identifier`);
    const id = raw.identifier!.toLowerCase();
    if (seen.has(id)) throw new HttpError(422, 'duplicate_identifier', `${path}.identifier`);
    seen.add(id);
    const start = parseDate(raw.start_date!, zone, `${path}.start_date`);
    const end = parseDate(raw.end_date!, zone, `${path}.end_date`);
    if (start.normalized.utc && end.normalized.utc && end.normalized.utc < start.normalized.utc) invalid(`${path}.end_date`);
    const duration = quantity(raw.duration, ['sec'], `${path}.duration`, 604800)!;
    const elapsed = quantity(raw.elapsed_time, ['sec'], `${path}.elapsed_time`, 604800);
    const energy = quantity(raw.energy_burned, ['kcal'], `${path}.energy_burned`, 100000);
    const active = quantity(raw.active_calories, [''], `${path}.active_calories`, 100000);
    const hr = quantity(raw.average_heart_rate, [''], `${path}.average_heart_rate`, 300);
    const flights = quantity(raw.flights_climbed, [''], `${path}.flights_climbed`, 100000);
    if (flights && !Number.isInteger(flights.value)) invalid(`${path}.flights_climbed`);
    return { raw, normalized: {
      identifier: id, type: raw.type, start: start.normalized, end: end.normalized,
      duration_seconds: duration.value, elapsed_seconds: elapsed?.value ?? null,
      energy_burned: energy ? { value: energy.value, unit: 'kcal', interpretation: 'unverified' } : null,
      active_calories: active ? { value: active.value, unit: 'kcal', unit_assumed: true } : null,
      average_heart_rate: hr ? { value: hr.value, unit: 'bpm', unit_assumed: true } : null,
      total_distance: quantity(raw.total_distance, ['m','km','mi','ft','yd'], `${path}.total_distance`),
      average_speed: quantity(raw.average_speed, ['m/s','km/h','km/hr','mi/hr','mph','kph'], `${path}.average_speed`),
      flights_climbed: flights?.value ?? null,
      is_from_watch: flag(raw.is_from_watch, `${path}.is_from_watch`),
      is_from_third_party: flag(raw.is_from_third_party, `${path}.is_from_third_party`),
    }};
  }).sort((a, b) => a.normalized.identifier < b.normalized.identifier ? -1 : 1);
  return {
    schema_version: 1, normalization_version: NORMALIZATION_VERSION,
    timezone_assumed: zone,
    input: { workouts: rows.map(r => r.raw) },
    workouts: rows,
    warnings: ['dates_assume_configured_timezone', 'dates_have_minute_precision',
      'duration_and_elapsed_meanings_unverified', 'energy_semantics_and_unitless_measurement_units_unverified'],
  };
}
