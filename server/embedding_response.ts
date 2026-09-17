// Embedding endpoints are local infrastructure, but their response allocation
// and diagnostics still have explicit bounds. Never echo a response payload.
export async function embeddingResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`embedding response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

export async function embeddingResponseJson(
  response: Response,
  maxBytes = 65536,
) {
  const text = await embeddingResponseText(response, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("embedding response is not valid JSON");
  }
}
