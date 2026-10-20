import type { Batch, Env } from './types.ts';
import { ARCHIVE_PREFIX } from './types.ts';
import { sha256 } from './normalize.ts';

export class DeliveryError extends Error {
  code: string;
  permanent: boolean;
  retryAfterMs: number;
  constructor(code: string, permanent = false, retryAfterMs = 0) {
    super(code); this.code = code; this.permanent = permanent; this.retryAfterMs = retryAfterMs;
  }
}
export function toBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function fromBase64(text: string) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(text.replace(/\s/g, '')), c => c.charCodeAt(0)));
}
export type Fetch = typeof fetch;
async function api(env: Env, path: string, init: RequestInit, request: Fetch) {
  try {
    const response = await request(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path ? `/${path}` : ''}`, {
      ...init, redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
        Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'digital-data-uploader',
        'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (response.status >= 300 && response.status < 400) {
      throw new DeliveryError('github_unexpected_redirect', true);
    }
    return response;
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError('github_network_error');
  }
}
async function data(response: Response): Promise<any> {
  // GitHub content is bounded by the upload/normalization limit (< 1 MiB).
  try { return await response.json(); } catch { throw new DeliveryError('github_invalid_response'); }
}
function failure(r: Response): never {
  const retry = r.headers.get('retry-after');
  let delay = 0;
  if (retry) {
    const n = Number(retry);
    delay = Number.isFinite(n) ? n * 1000 : Date.parse(retry) - Date.now();
  }
  if (r.headers.get('x-ratelimit-remaining') === '0') {
    delay = Math.max(delay, Number(r.headers.get('x-ratelimit-reset') ?? 0) * 1000 - Date.now());
  }
  if (!Number.isFinite(delay)) delay = 0;
  const limited = r.status === 429 || (r.status === 403 && (delay > 0 || r.headers.get('x-ratelimit-remaining') === '0'));
  if (limited) throw new DeliveryError('github_rate_limited', false, Math.max(60000, Math.min(delay || 60000, 86400000)));
  if ([401, 403, 404].includes(r.status)) throw new DeliveryError('github_access_denied', true);
  if (r.status === 400) throw new DeliveryError('github_request_rejected', true);
  // A competing create of this immutable path may return 422. Retry from GET
  // to verify existing bytes, never overwrite them.
  if (r.status === 422) throw new DeliveryError('github_create_conflict');
  if (r.status === 409) throw new DeliveryError('github_branch_conflict');
  throw new DeliveryError('github_unavailable');
}
export async function archive(env: Env, b: Batch, request: Fetch = fetch): Promise<string> {
  if (!b.envelope) throw new DeliveryError('missing_pending_payload', true);
  const repository = await api(env, '', {}, request);
  if (!repository.ok) failure(repository);
  if ((await data(repository)).private !== true) throw new DeliveryError('destination_not_private', true);
  const path = `${ARCHIVE_PREFIX}${b.id}.json`;
  const contentPath = `contents/${path}`;
  const existing = await api(env, `${contentPath}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`, {}, request);
  if (existing.ok) {
    const info = await data(existing);
    if (info.type !== 'file' || info.encoding !== 'base64' || typeof info.content !== 'string') {
      throw new DeliveryError('archive_content_unverifiable', true);
    }
    let hash: string;
    try { hash = await sha256(fromBase64(info.content)); }
    catch { throw new DeliveryError('archive_content_unverifiable', true); }
    if (hash !== b.archive_hash) throw new DeliveryError('archive_content_conflict', true);
    // The Contents API SHA is a blob SHA, not a commit SHA. Find the commit that
    // last touched this immutable path when recovering after a successful PUT.
    const commits = await api(env, `commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(env.GITHUB_BRANCH)}&per_page=1`, {}, request);
    if (!commits.ok) failure(commits);
    const history = await data(commits);
    const sha = history?.[0]?.sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new DeliveryError('github_invalid_response');
    return sha;
  }
  if (existing.status !== 404) failure(existing);
  // 404 can mean a missing file OR a private-repo permission problem. The create
  // request disambiguates; a denied create becomes a visible permanent failure.
  const created = await api(env, contentPath, {
    method: 'PUT', body: JSON.stringify({ message: 'Archive Apple Health workout batch',
      branch: env.GITHUB_BRANCH, content: toBase64(b.envelope) }),
  }, request);
  if (!created.ok) failure(created);
  const result = await data(created);
  if (typeof result.commit?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(result.commit.sha)) {
    throw new DeliveryError('github_invalid_response');
  }
  return result.commit.sha;
}
