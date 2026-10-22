import { HttpError } from './types.ts';

// Bound actual streamed bytes as well as Content-Length for every upload format.
export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (request.headers.has('Content-Encoding') && request.headers.get('Content-Encoding') !== 'identity') {
    throw new HttpError(415, 'unsupported_content_encoding');
  }
  const claimed = request.headers.get('Content-Length');
  if (claimed && (!/^\d+$/.test(claimed) || Number(claimed) > maxBytes)) throw new HttpError(413, 'body_too_large');
  if (!request.body) throw new HttpError(400, 'empty_body');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0, timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 10000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new HttpError(408, 'body_read_timeout');
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new HttpError(413, 'body_too_large'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'body_read_failed');
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return buffer;
}
