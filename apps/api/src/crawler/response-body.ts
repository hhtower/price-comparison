/** Bound decompressed response bytes, including chunked bodies and cancellation. */
export async function boundedResponse(response: Response, signal: AbortSignal, maxBytes = 2 * 1024 * 1024): Promise<Response> {
  signal.throwIfAborted();
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('接口响应超过大小限制');
  }
  const reader = response.body?.getReader();
  if (!reader) return response;
  const chunks: Uint8Array[] = [];
  let length = 0, complete = false;
  let abort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) { complete = true; break; }
      length += value.byteLength;
      if (length > maxBytes) throw new Error('接口响应超过大小限制');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
