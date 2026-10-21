import type { NewBatch, NormalizedBatch, SourceAdapter } from './types.ts';
import { canonical, sha256 } from './json.ts';
import { appleHealth } from './sources/apple-health.ts';

// Server-owned allowlist: request JSON cannot select arbitrary archive paths.
const sources: readonly SourceAdapter[] = [appleHealth];

export function getUploadSource(path: string): SourceAdapter | undefined {
  return sources.find(source => source.uploadPath === path);
}

export async function createBatch(source: SourceAdapter, result: NormalizedBatch,
  receivedAt = new Date().toISOString()): Promise<NewBatch> {
  const identity = source.legacyBatchIdentity ? result.identity :
    { source: source.id, input: result.identity };
  const id = await sha256(canonical(identity));
  const envelope = canonical({ ...result.payload, batch_id: id, received_at: receivedAt });
  return { id, source: source.id, record_count: result.recordCount,
    archive_path: `${source.archivePrefix}${id}.json`, envelope,
    archive_hash: await sha256(envelope), received_at: receivedAt };
}
