export async function readBoundedBody(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null && !/^\d+$/.test(rawLength)) throw new Error(`${label} has an invalid Content-Length`);
  const declared = rawLength === null ? null : Number(rawLength);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > maxBytes)) {
    throw new Error(`${label} exceeds configured byte limit`);
  }
  if (!response.body) throw new Error(`${label} response has no body`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds configured byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size);
}
