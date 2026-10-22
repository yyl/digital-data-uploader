import { HttpError } from '../types.ts';

export const STRONG_PATH = 'files/strong_workouts.csv';
export const MAX_STRONG_BYTES = 512 * 1024;
const requiredColumns = ['Date', 'Workout Name', 'Duration', 'Exercise Name', 'Set Order',
  'Weight', 'Reps', 'Distance', 'Seconds'];

// Validate CSV structure without interpreting workouts or changing any file bytes.
function validateCsv(csv: string) {
  if (csv.includes('\0')) throw new HttpError(422, 'invalid_strong_csv');
  let field = '', row: string[] = [], columns: string[] | undefined;
  let quoted = false, closed = false, records = 0;
  const endField = () => { row.push(field); field = ''; closed = false; };
  const endRow = () => {
    endField();
    if (row.length === 1 && row[0] === '') { row = []; return; }
    if (!columns) {
      columns = row;
      if (new Set(columns).size !== columns.length || !requiredColumns.every(c => columns!.includes(c))) {
        throw new HttpError(422, 'invalid_strong_header');
      }
    } else {
      if (row.length !== columns.length || !row[columns.indexOf('Date')]?.trim()) {
        throw new HttpError(422, 'invalid_strong_csv');
      }
      records++;
    }
    row = [];
  };
  for (let i = csv.charCodeAt(0) === 0xFEFF ? 1 : 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += c;
    } else if (c === ',') endField();
    else if (c === '\r' || c === '\n') {
      endRow();
      if (c === '\r' && csv[i + 1] === '\n') i++;
    } else if (c === '"' && !field && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new HttpError(422, 'invalid_strong_csv');
      field += c;
    }
  }
  if (quoted) throw new HttpError(422, 'invalid_strong_csv');
  if (field || row.length || closed) endRow();
  if (!columns) throw new HttpError(422, 'invalid_strong_header');
  if (!records) throw new HttpError(422, 'empty_strong_export');
}

export async function readStrongCsv(request: Request, bytes: Uint8Array): Promise<string> {
  if (request.headers.get('Content-Type') !== 'text/csv') {
    throw new HttpError(415, 'expected_csv');
  }
  let csv: string;
  // Keep a UTF-8 BOM, if present, so re-encoding preserves the original bytes.
  try { csv = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new HttpError(400, 'invalid_utf8'); }
  validateCsv(csv);
  return csv;
}
