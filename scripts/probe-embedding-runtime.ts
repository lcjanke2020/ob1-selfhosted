// Synthetic, inference-only probe for the pinned Nomic model and a candidate runtime.
// Imports the actual app embedder/runtime gate/chunker, but supplies dummy app
// configuration and never connects to PostgreSQL or calls capture/update APIs.
// Run against an isolated candidate. The selected source contains no private data.
// Example (from the repository root):
// OLLAMA_URL=http://127.0.0.1:11434 deno run --config server/deno.json --frozen \
//   --allow-env --allow-net=127.0.0.1:11434 scripts/probe-embedding-runtime.ts
// These bounded synthetic checks are smoke evidence, not a corpus quality eval.

Deno.env.set("DB_PASSWORD", "synthetic-probe");
Deno.env.set("MCP_ACCESS_KEY", "synthetic-probe-key-".repeat(4));
Deno.env.set("METADATA_FALLBACK_POLICY", "off");
const base = Deno.env.get("OLLAMA_URL")?.replace(/\/$/, "");
if (!base) throw new Error("Set OLLAMA_URL to the isolated candidate endpoint");
Deno.env.set("EMBED_MODEL", "nomic-embed-text:latest");
const { buildEmbeddingIndex, EmbeddingContextError } = await import(
  "../server/embedding_index.ts"
);
const { embed } = await import("../server/embeddings.ts");
const { embeddingContract } = await import("../server/embedding_runtime.ts");

async function readMetadata(route: string) {
  const response = await fetch(`${base}/api/${route}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`metadata ${route}: HTTP ${response.status}`);
  }
  return await response.json();
}
const version = await readMetadata("version");
const tags = await readMetadata("tags");
const model = tags.models.find((m: { name: string }) =>
  m.name === "nomic-embed-text:latest"
);
const expected =
  "0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f";
console.log(
  JSON.stringify({
    stage: "identity",
    runtime: version.version,
    model: model.name,
    digest: model.digest,
    same_model: model.digest === expected,
  }),
);
if (model.digest !== expected) {
  throw new Error("Model digest differs from deployed artifact");
}
const start = performance.now();
const contract = await embeddingContract();
console.log(
  JSON.stringify({
    stage: "runtime_canary",
    contract,
    ms: Math.round(performance.now() - start),
  }),
);
const cosine = (a: number[], b: number[]) =>
  a.reduce((s, x, i) => s + x * b[i], 0) /
  Math.sqrt(
    a.reduce((s, x) => s + x * x, 0) * b.reduce((s, x) => s + x * x, 0),
  );
const pumpUpper = await embed("REPLACE SUMP PUMP");
const pumpLower = await embed("replace sump pump");
const sheetUpper = await embed("CREATE A SPREADSHEET");
console.log(JSON.stringify({
  stage: "casing",
  same_phrase_cosine: cosine(pumpUpper, pumpLower),
  different_phrase_cosine: cosine(pumpUpper, sheetUpper),
  different_phrase_equal: pumpUpper.every((x, i) => x === sheetUpper[i]),
}));
if (
  cosine(pumpUpper, pumpLower) < 0.999 ||
  pumpUpper.every((x, i) => x === sheetUpper[i])
) throw new Error("Casing regression");
const accent = await embed("The café serves coffee.");
const plain = await embed("The cafe serves coffee.");
console.log(
  JSON.stringify({
    stage: "accent",
    same_phrase_cosine: cosine(accent, plain),
  }),
);
for (const n of [2046, 2047, 8190, 8191]) {
  try {
    const r = await embed("x ".repeat(n));
    if (n !== 2046) throw new Error("Expected strict context overflow");
    console.log(
      JSON.stringify({
        stage: "strict_boundary",
        repetitions: n,
        ok: true,
        dim: r.length,
      }),
    );
  } catch (e) {
    if (n === 2046 || !(e instanceof EmbeddingContextError)) throw e;
    console.log(
      JSON.stringify({
        stage: "strict_boundary",
        repetitions: n,
        ok: false,
        error: (e as Error).message,
      }),
    );
  }
}
for (
  const [name, text] of [
    ["prose", "A shared garden has fruit trees and flowers. ".repeat(260)],
    [
      "code",
      "src/runtime/transport.ts 01234567-89ab-cdef-0123-456789abcdef function(){return true;}\n"
        .repeat(120),
    ],
    ["cjk", "中文测试".repeat(1000)],
    ["combining", "e\u0301 ".repeat(3000)],
    ["nonbmp", "👩🏽‍🚀 rocket ".repeat(700)],
    ["boundary2046", " a".repeat(2046)],
    ["boundary2047", " a".repeat(2047)],
  ] as const
) {
  const start = performance.now();
  try {
    const result = await buildEmbeddingIndex(
      text,
      ["content"],
      embed,
      "synthetic-fit-probe",
    );
    console.log(JSON.stringify({
      name,
      source_bytes: result.sourceBytes,
      source_units: result.sourceUnits,
      chunks: result.vectors.length,
      dim: result.vectors[0].length,
      ms: Math.round(performance.now() - start),
    }));
  } catch (e) {
    console.log(
      JSON.stringify({
        name,
        ms: Math.round(performance.now() - start),
        error: (e as Error).message,
      }),
    );
    throw e;
  }
}

const common =
  "This log records routine maintenance work and notes for future reference. "
    .repeat(130);
const docs = [
  [
    "pump",
    common +
    "To replace the basement sump pump, disconnect power, remove the old pump, reconnect the discharge pipe and test the float switch.",
  ],
  [
    "sheet",
    common +
    "Create a spreadsheet to track monthly household expenses, with columns for dates, categories and amounts, and formulas for totals.",
  ],
  [
    "orchard",
    common +
    "Prune apple trees in the orchard during winter dormancy. Remove dead branches and crossing limbs to improve air circulation.",
  ],
] as const;
const indexes = [];
for (const [id, text] of docs) {
  const deadline = performance.now() + 15000;
  const before = await embeddingContract({ deadline });
  const index = await buildEmbeddingIndex(
    text,
    ["content"],
    embed,
    before,
    deadline,
  );
  if (await embeddingContract({ deadline }) !== before) {
    throw new Error("Contract drift");
  }
  indexes.push({ id, ...index });
}
for (
  const [expected, query] of [
    ["pump", "REPLACE SUMP PUMP"],
    ["sheet", "How can I make a spreadsheet to track spending?"],
    ["orchard", "When should I prune apple trees?"],
  ] as const
) {
  const v = await embed(query);
  const ranked = indexes.map((d) => ({
    id: d.id,
    score: Math.max(...d.vectors.map((x) => cosine(v, x))),
    best_chunk: d.vectors.reduce(
      (best, x, i, all) => cosine(v, x) > cosine(v, all[best]) ? i : best,
      0,
    ),
    chunks: d.vectors.length,
  })).sort((a, b) => b.score - a.score);
  console.log(
    JSON.stringify({
      stage: "retrieval",
      expected,
      top: ranked[0].id,
      pass: ranked[0].id === expected,
      best_chunk: ranked[0].best_chunk,
      chunks: ranked[0].chunks,
      scores: ranked,
    }),
  );
  if (ranked[0].id !== expected || ranked[0].best_chunk === 0) {
    throw new Error("Late-passage retrieval smoke failed");
  }
}
const resident = await readMetadata("ps");
console.log(JSON.stringify({
  stage: "resident",
  models: resident.models.map((
    m: {
      name: string;
      digest: string;
      context_length: number;
      size_vram: number;
    },
  ) => ({
    name: m.name,
    digest: m.digest,
    context_length: m.context_length,
    size_vram: m.size_vram,
  })),
}));
