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
  source: string;
  record_count: number;
  archive_path: string;
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
export const MAX_PENDING_BYTES = 32 * 1024 * 1024;
export const MAX_RECEIPTS = 50_000;

export type NewBatch = Pick<Batch, 'id' | 'source' | 'record_count' | 'archive_path' |
  'archive_hash' | 'envelope' | 'received_at'> & { envelope: string };

export interface NormalizedBatch {
  recordCount: number;
  identity: Record<string, unknown>;
  payload: Record<string, unknown>;
}
export interface SourceAdapter {
  id: string;
  uploadPath: string;
  archivePrefix: string;
  normalize(input: unknown, zone: string): NormalizedBatch;
  // Compatibility exception for the original Apple Health batch IDs only.
  legacyBatchIdentity?: boolean;
}
