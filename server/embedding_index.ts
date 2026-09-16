// Index-only documents. Canonical text never passes through a truncation or
// normalization step here. A character target is a work heuristic, not proof
// of token fit: only a successful strict embedding establishes that.
export const EMBEDDING_INDEX_VERSION = "passages-v1-no-prefix";
export const MAX_EMBEDDING_CHUNKS = 128;
export const MAX_EMBEDDING_ATTEMPTS = 255;
export const INITIAL_CHUNK_UNITS = 4096;
export const MAX_EMBEDDING_SOURCE_BYTES = 100_000;
export const MAX_EMBEDDING_DURATION_MS = 15_000;

export class EmbeddingContextError extends Error {}

export type EmbedOne = (
  text: string,
  options?: { deadline: number },
) => Promise<number[]>;

export type EmbeddingIndex = {
  contract: string;
  sourceHash: string;
  sourceBytes: number;
  sourceUnits: number;
  fields: string[];
  vectors: number[][];
};

export function embeddingCoverage(index: EmbeddingIndex) {
  return {
    complete: true as const,
    fields: index.fields,
    utf8_bytes: index.sourceBytes,
    utf16_units: index.sourceUnits,
    chunks: index.vectors.length,
    contract: index.contract,
  };
}

export type EmbeddingCoverage = ReturnType<typeof embeddingCoverage>;

export async function sourceHash(source: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

// Never split a surrogate pair, combining sequence, or emoji grapheme. A
// Prefer a boundary at/before the target, then the first boundary after it.
// Zero means there is no interior boundary, not merely no earlier boundary.
function splitPoint(text: string, target: number): number {
  let point = 0;
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  for (const segment of segmenter.segment(text)) {
    if (segment.index > target) return point || segment.index;
    point = segment.index;
  }
  return point;
}

export async function buildEmbeddingIndex(
  source: string,
  fields: string[],
  embed: EmbedOne,
  contract: string,
  deadline = performance.now() + MAX_EMBEDDING_DURATION_MS,
): Promise<EmbeddingIndex> {
  const bytes = new TextEncoder().encode(source).length;
  const context = `fields=${
    fields.join(",")
  }; utf8_bytes=${bytes}; utf16_units=${source.length}`;
  const fail = (reason: string): Error =>
    new Error(`embedding document: ${reason}; ${context}; write=not_started`);
  if (!source.isWellFormed()) throw fail("invalid Unicode");
  if (bytes > MAX_EMBEDDING_SOURCE_BYTES) {
    throw fail(`source exceeds ${MAX_EMBEDDING_SOURCE_BYTES} UTF-8 bytes`);
  }
  const vectors: number[][] = [];
  let attempts = 0;
  const visit = async (text: string): Promise<void> => {
    if (performance.now() >= deadline) throw fail("deadline exceeded");
    if (vectors.length >= MAX_EMBEDDING_CHUNKS) {
      throw fail(`exceeds ${MAX_EMBEDDING_CHUNKS} chunks`);
    }
    // This is a size target, not a second context limit. An indivisible
    // grapheme is sent intact, subject to the source-byte/job bounds; only
    // the strict model response can establish whether that grapheme fits.
    if (text.length > INITIAL_CHUNK_UNITS) {
      const point = splitPoint(text, INITIAL_CHUNK_UNITS);
      if (point > 0) {
        await visit(text.slice(0, point));
        await visit(text.slice(point));
        return;
      }
    }
    if (++attempts > MAX_EMBEDDING_ATTEMPTS) {
      throw fail(`exceeds ${MAX_EMBEDDING_ATTEMPTS} embedding attempts`);
    }
    try {
      const vector = await embed(text, { deadline });
      if (performance.now() >= deadline) throw fail("deadline exceeded");
      vectors.push(vector);
    } catch (error) {
      if (!(error instanceof EmbeddingContextError)) throw error;
      const point = splitPoint(text, Math.floor(text.length / 2));
      if (point === 0) throw fail("one grapheme exceeds model context");
      await visit(text.slice(0, point));
      await visit(text.slice(point));
    }
  };
  await visit(source);
  return {
    contract,
    sourceHash: await sourceHash(source),
    sourceBytes: bytes,
    sourceUnits: source.length,
    fields,
    vectors,
  };
}
