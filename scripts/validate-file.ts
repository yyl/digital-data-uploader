import { readFileSync } from 'node:fs';
import { normalize } from '../src/normalize.ts';
const path = process.argv[2];
if (!path) { console.error('Usage: npm run validate-file -- /path/to/workouts.json'); process.exit(1); }
try {
  const result = normalize(JSON.parse(readFileSync(path,'utf8')), process.env.ASSUMED_TIMEZONE || 'America/Los_Angeles');
  console.log(JSON.stringify({ valid:true, workouts:result.workouts.length,
    fields:[...new Set(result.workouts.flatMap(w=>Object.keys(w.raw)))].sort(),
    unresolved_dates:result.workouts.flatMap(w=>[w.normalized.start,w.normalized.end]).filter(d=>d.utc===null).length,
    warnings:result.warnings },null,2));
} catch { console.error('Validation failed. Check the documented input fields, date format, and units.'); process.exit(1); }
