export interface Env {
  DB: D1Database;
  UPLOAD_TOKEN: string;
  ADMIN_TOKEN: string;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  ASSUMED_TIMEZONE?: string;
}
export interface Batch {
  id: string;
  archive_hash: string;
  envelope: string | null;
  payload_bytes: number;
  workout_count: number;
  received_at: string;
  state: 'queued' | 'retrying' | 'failed' | 'archived';
  attempts: number;
  next_attempt: number;
  last_error: string | null;
  commit_sha: string | null;
  archived_at: string | null;
}
export class HttpError extends Error {
  status: number;
  code: string;
  field?: string;
  constructor(status: number, code: string, field?: string) {
    super(code); this.status = status; this.code = code; this.field = field;
  }
}
export const MAX_BYTES = 256 * 1024;
export const MAX_WORKOUTS = 100;
export const MAX_PENDING_BYTES = 32 * 1024 * 1024;
export const MAX_RECEIPTS = 50_000;
export const ARCHIVE_PREFIX = 'files/apple_health/actions/batches/';
export const NORMALIZATION_VERSION = 1;
