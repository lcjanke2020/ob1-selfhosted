import {
  EMBED_DIM,
  EMBED_MODEL,
  FETCH_TIMEOUT_MS,
  OLLAMA_URL,
} from "./config.ts";
import { boundedFetch } from "./bounded_fetch.ts";
import { embed } from "./embeddings.ts";
import { embeddingResponseJson } from "./embedding_response.ts";
import {
  EMBEDDING_INDEX_VERSION,
  MAX_EMBEDDING_DURATION_MS,
  sourceHash,
} from "./embedding_index.ts";

let validatedContract: string | undefined;

// Identity includes runtime (tokenizer implementation), model manifest, task
// prefix policy and dimensions. A mutable model name alone is not an identity.
export async function embeddingContract(
  options?: { deadline: number },
): Promise<string> {
  options ??= { deadline: performance.now() + MAX_EMBEDDING_DURATION_MS };
  const read = (path: string) => {
    const timeoutMs = Math.min(
      FETCH_TIMEOUT_MS,
      Math.ceil((options?.deadline ?? Infinity) - performance.now()),
    );
    if (timeoutMs <= 0) throw new Error("embedding identity deadline exceeded");
    return boundedFetch(
      `${OLLAMA_URL}/api/${path}`,
      { timeoutMs },
      async (r) => {
        if (!r.ok) throw new Error(`embedding identity: HTTP ${r.status}`);
        return await embeddingResponseJson(r, 262144);
      },
    );
  };
  const [runtime, tags] = await Promise.all([read("version"), read("tags")]);
  const name = EMBED_MODEL.includes(":")
    ? EMBED_MODEL
    : `${EMBED_MODEL}:latest`;
  const model = tags?.models?.find((m: { name?: string }) => m.name === name);
  if (
    typeof runtime?.version !== "string" ||
    !/^[a-zA-Z0-9.+_-]{1,80}$/.test(runtime.version) ||
    typeof model?.digest !== "string" ||
    !/^(sha256:)?[a-f0-9]{64}$/.test(model.digest)
  ) {
    throw new Error(
      "embedding identity: runtime version or model digest unavailable",
    );
  }
  const contract = await sourceHash(JSON.stringify({
    version: EMBEDDING_INDEX_VERSION,
    runtime: runtime.version,
    model: name,
    digest: model.digest.replace(/^sha256:/, ""),
    dimensions: EMBED_DIM,
  }));
  if (validatedContract !== contract) {
    // The measured tokenizer regression makes unrelated uppercase words
    // identical. This is a targeted corruption canary, not a quality eval or
    // a claim that arbitrary future tokenizer bugs can be detected here.
    const a = await embed("QUARTZ ZEPHYR WALRUS", options);
    const b = await embed("BANANA ENGINE COSMOS", options);
    if (a.every((value, i) => value === b[i])) {
      throw new Error(
        "embedding runtime: distinct-input canary collision; validate a corrected runtime before indexing",
      );
    }
    validatedContract = contract;
  }
  return contract;
}
