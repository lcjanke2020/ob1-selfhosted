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

export const RUNTIME_VERSION_PATTERN = /^[a-zA-Z0-9.+_-]{1,80}$/;

export type EmbeddingIdentity = Readonly<{
  runtime: string;
  model: string;
  digest: string;
}>;

// The runtime version and contract whose distinct-input canary last passed.
let validated: { runtime: string; contract: string } | undefined;

export async function readEmbeddingIdentity(
  options: { deadline: number },
): Promise<EmbeddingIdentity> {
  const read = (path: string) => {
    const timeoutMs = Math.min(
      FETCH_TIMEOUT_MS,
      Math.ceil(options.deadline - performance.now()),
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
    !RUNTIME_VERSION_PATTERN.test(runtime.version) ||
    typeof model?.digest !== "string" ||
    !/^(sha256:)?[a-f0-9]{64}$/.test(model.digest)
  ) {
    throw new Error(
      "embedding identity: runtime version or model digest unavailable",
    );
  }
  return {
    runtime: runtime.version,
    model: name,
    digest: model.digest.replace(/^sha256:/, ""),
  };
}

// Vector identity: index strategy (task prefix policy included), model
// manifest and dimensions. A mutable model name alone is not an identity. The
// runtime version is deliberately excluded: releases rarely change a pinned
// model's vectors, and an unmanaged runtime (for example a native install
// upgraded by desktop management) can change at any time, even mid-job. A
// proven corruption still fails closed through the canary below; subtler drift
// is left to monitoring and an explicit rebuild, never a write gate.
export function contractFor(
  identity: Omit<EmbeddingIdentity, "runtime">,
): Promise<string> {
  return sourceHash(JSON.stringify({
    version: EMBEDDING_INDEX_VERSION,
    model: identity.model,
    digest: identity.digest,
    dimensions: EMBED_DIM,
  }));
}

// Server 1.28 also hashed the runtime version. Only the one-time relabel uses
// this, to prove which activated generation it converts.
export function legacyContractFor(
  identity: Omit<EmbeddingIdentity, "runtime">,
  runtime: string,
): Promise<string> {
  return sourceHash(JSON.stringify({
    version: EMBEDDING_INDEX_VERSION,
    runtime,
    model: identity.model,
    digest: identity.digest,
    dimensions: EMBED_DIM,
  }));
}

export async function embeddingContract(
  options?: { deadline: number },
): Promise<string> {
  options ??= { deadline: performance.now() + MAX_EMBEDDING_DURATION_MS };
  const identity = await readEmbeddingIdentity(options);
  const contract = await contractFor(identity);
  if (
    validated?.runtime !== identity.runtime || validated.contract !== contract
  ) {
    // Every newly observed runtime must pass before its vectors are used,
    // including one swapped in between a job's start and end identity checks.
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
    if (validated && validated.runtime !== identity.runtime) {
      console.warn(
        `[embedding] runtime version changed ${validated.runtime} -> ${identity.runtime}; distinct-input canary passed`,
      );
    } else if (!validated) {
      console.log(
        `[embedding] runtime ${identity.runtime} passed the distinct-input canary`,
      );
    }
    validated = { runtime: identity.runtime, contract };
  }
  return contract;
}
