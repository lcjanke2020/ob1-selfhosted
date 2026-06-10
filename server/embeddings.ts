import {
  EMBED_DIM,
  EMBED_MODEL,
  FETCH_TIMEOUT_MS,
  OLLAMA_URL,
} from "./config.ts";

// Ollama's /api/embed (plural) returns { embeddings: [[...]] }. Older
// /api/embeddings (singular) returns { embedding: [...] } and is deprecated;
// we use the newer endpoint for compatibility with batch use later.
export async function embed(text: string): Promise<number[]> {
  const truncated = text.slice(0, 8000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let r: Response;
  try {
    r = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: truncated }),
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(
        `Ollama embed timed out after ${FETCH_TIMEOUT_MS}ms at ${OLLAMA_URL}/api/embed`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`Ollama embed failed: ${r.status} ${detail.slice(0, 300)}`);
  }
  const data = await r.json();
  const vec = data?.embeddings?.[0];
  if (!Array.isArray(vec)) {
    throw new Error("Ollama returned no embedding vector");
  }
  if (vec.length !== EMBED_DIM) {
    throw new Error(
      `Embedding dim mismatch: model "${EMBED_MODEL}" returned ${vec.length}, ` +
        `but EMBED_DIM is ${EMBED_DIM}. Update EMBED_DIM and the vector(N) ` +
        `column in db/01-schema.sql to match.`,
    );
  }
  return vec;
}

// Postgres pgvector accepts a string literal like '[0.1,0.2,...]' cast to vector.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
