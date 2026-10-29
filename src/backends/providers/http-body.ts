/** Read a response with a strict byte cap; retain each service's own error type. */
export async function readCapped(response: Response, maxBytes: number, limitError: () => Error): Promise<Buffer> {
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader(),
    chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw limitError();
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
