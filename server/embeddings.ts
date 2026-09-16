import {
  EMBED_DIM,
  EMBED_MODEL,
  FETCH_TIMEOUT_MS,
  OLLAMA_URL,
} from "./config.ts";
import { boundedFetch, BoundedFetchTimeoutError } from "./bounded_fetch.ts";
import { EmbeddingContextError } from "./embedding_index.ts";
import {
  embeddingResponseJson,
  embeddingResponseText,
} from "./embedding_response.ts";

let inFlight = 0;

// Ollama's /api/embed (plural) returns { embeddings: [[...]] }. Older
// /api/embeddings (singular) returns { embedding: [...] } and is deprecated;
// we use the newer endpoint for compatibility with batch use later.
export async function embed(
  text: string,
  options?: { deadline: number },
): Promise<number[]> {
  const url = `${OLLAMA_URL}/api/embed`;
  const timeoutMs = options
    ? Math.min(
      FETCH_TIMEOUT_MS,
      Math.ceil(options.deadline - performance.now()),
    )
    : FETCH_TIMEOUT_MS;
  if (timeoutMs <= 0) throw new Error("embedding request deadline exceeded");
  if (inFlight >= 2) throw new Error("embedding backend busy; retry later");
  inFlight++;

  try {
    return await boundedFetch(
      url,
      {
        timeoutMs,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: EMBED_MODEL,
            input: text,
            truncate: false,
          }),
        },
      },
      async (r) => {
        if (!r.ok) {
          let detail = "";
          try {
            detail = await embeddingResponseText(r, 8192);
          } catch (e) {
            // Preserve the best-effort error detail behavior, but do not
            // swallow the request deadline while an error body is stalled.
            if ((e as Error).name === "AbortError") throw e;
          }
          // Never reflect upstream bodies: they may echo private input.
          if (r.status === 400) {
            try {
              if (
                JSON.parse(detail).error ===
                  "the input length exceeds the context length"
              ) {
                throw new EmbeddingContextError(
                  "embedding input exceeds model context",
                );
              }
            } catch (error) {
              if (error instanceof EmbeddingContextError) throw error;
            }
          }
          throw new Error(`Ollama embed failed: HTTP ${r.status}`);
        }
        const data = await embeddingResponseJson(r);
        const vec = data?.embeddings?.[0];
        if (!Array.isArray(vec) || data.embeddings.length !== 1) {
          throw new Error("Ollama returned no embedding vector");
        }
        if (vec.length !== EMBED_DIM) {
          throw new Error(
            `Embedding dim mismatch: model "${EMBED_MODEL}" returned ${vec.length}, ` +
              `but EMBED_DIM is ${EMBED_DIM}. Update EMBED_DIM and the vector(N) ` +
              `columns and index checks in db/01-schema.sql, db/04-sessions.sql and db/15-embedding-index.sql to match.`,
          );
        }
        // pgvector's behavior on non-finite floats is undefined — a
        // NaN/Infinity slipping into the index can corrupt distance results
        // silently. Refuse loudly instead.
        if (!vec.every((v) => typeof v === "number" && Number.isFinite(v))) {
          throw new Error(
            `Embedding from model "${EMBED_MODEL}" contains non-finite values ` +
              `(NaN/Infinity); refusing to store.`,
          );
        }
        if (!vec.some((v) => v !== 0)) {
          throw new Error("Ollama returned a zero embedding vector");
        }
        return vec;
      },
    );
  } catch (e) {
    if (e instanceof BoundedFetchTimeoutError) {
      throw new Error(
        `Ollama embed timed out after ${timeoutMs}ms`,
      );
    }
    throw e;
  } finally {
    inFlight--;
  }
}

// Postgres pgvector accepts a string literal like '[0.1,0.2,...]' cast to vector.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
