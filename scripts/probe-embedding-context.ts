// Read-only synthetic inference probe. Never calls OpenBrain capture/update APIs.
// Requires explicit OLLAMA_URL and EMBED_MODEL environment variables.
// Run all cases with no arguments, or pass case names to select a subset.
// Output contains sizes, statuses, vector hashes and metadata, not raw vectors.

type Probe = {
  name: string;
  input: string;
  truncate?: boolean;
  options?: { num_ctx: number };
};

const probes: Probe[] = [
  { name: "tiny", input: "hello" },
  ...[2045, 2046, 2047].map((n) => ({
    name: `ascii-${n}-strict`,
    input: "x ".repeat(n),
    truncate: false,
  })),
  { name: "ascii-2100-default", input: "x ".repeat(2100) },
  { name: "ascii-2100-truncate", input: "x ".repeat(2100), truncate: true },
  { name: "ascii-2100-strict", input: "x ".repeat(2100), truncate: false },
  {
    name: "ascii-2100-context8192",
    input: "x ".repeat(2100),
    truncate: false,
    options: { num_ctx: 8192 },
  },
  {
    name: "prose-8000",
    input:
      "We reviewed the service and recorded the next steps for the project. "
        .repeat(140).slice(0, 8000),
  },
  {
    name: "paths-8000",
    input:
      "~/.codex/rules/default.rules tmp/20260916-120000-embedding-context 01234567-89ab-cdef-0123-456789abcdef "
        .repeat(100).slice(0, 8000),
  },
  ...[2045, 2046].map((n) => ({
    name: `cjk-${n}-strict`,
    input: "数".repeat(n),
    truncate: false,
  })),
  { name: "cjk-2047-default", input: "数".repeat(2047) },
  { name: "cjk-3000-default", input: "数据库嵌入".repeat(600) },
  {
    name: "cjk-3000-truncate",
    input: "数据库嵌入".repeat(600),
    truncate: true,
  },
  { name: "combining-6000", input: "e\u0301 ".repeat(2000) },
  { name: "nonbmp-6000", input: "😀 ".repeat(2000) },
  {
    name: "code-8000",
    input:
      "const foo_bar = await svc.session_capture({toml_text: payload}); // réembedding\n"
        .repeat(110).slice(0, 8000),
  },
  {
    name: "uuid-8000",
    input: "01234567-89ab-cdef-0123-456789abcdef ".repeat(240).slice(0, 8000),
  },
  {
    name: "session-8000",
    input: [
      "Embedding failure investigation",
      "Fix session_capture",
      "Diagnosed token/context mismatch. ".repeat(40),
      "~/.codex/rules/default.rules; approvals_reviewer=auto_review; tmp/20260916-120000-test; 混合文本 😀\n"
        .repeat(80),
    ].join("\0").slice(0, 8000),
  },
  { name: "ascii-2047-default", input: "x ".repeat(2047) },
  { name: "unknown-after-cut", input: "x ".repeat(2100) + "😀" },
  { name: "unknown-before-cut", input: "😀 " + "x ".repeat(2100) },
  { name: "uppercase-before-cut", input: "X " + "x ".repeat(2099) },
  { name: "uppercase-pump", input: "REPLACE SUMP PUMP" },
  { name: "uppercase-spreadsheet", input: "CREATE A SPREADSHEET" },
  { name: "lowercase-pump", input: "replace sump pump" },
  { name: "lowercase-spreadsheet", input: "create a spreadsheet" },
];

const selected = new Set(Deno.args);
for (const name of selected) {
  if (!probes.some((probe) => probe.name === name)) {
    throw new Error(`Unknown probe: ${name}`);
  }
}
const base = Deno.env.get("OLLAMA_URL")?.replace(/\/$/, "");
const model = Deno.env.get("EMBED_MODEL");
if (!base || !model) {
  throw new Error("Set OLLAMA_URL and EMBED_MODEL explicitly");
}
const encoder = new TextEncoder();

// Compare exact numeric arrays without publishing 768 floating-point values.
// This fingerprint is not a measure of retrieval quality or cross-runtime drift.
async function vectorHash(vector: unknown): Promise<string | null> {
  if (!Array.isArray(vector)) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify(vector)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function request(route: string, body?: unknown) {
  const response = await fetch(`${base}/api/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  return { status: response.status, data: await response.json() };
}

const version = await request("version");
const show = await request("show", { model });
if (version.status !== 200 || show.status !== 200) {
  throw new Error("Could not read Ollama version and model metadata");
}
console.log(JSON.stringify({
  kind: "deployment",
  at: new Date().toISOString(),
  model,
  version: version.data.version,
  parameters: show.data.parameters,
  model_info: Object.fromEntries(
    Object.entries(show.data.model_info ?? {}).filter(([key]) =>
      /architecture|context_length|embedding_length|tokenizer.ggml.model/.test(
        key,
      )
    ),
  ),
}));

// Serial requests avoid adding a concurrent batch to the live CPU embedder.
// HTTP 400 is an observation, not a script failure. Network/parse failures abort.
for (const { name, input, ...options } of probes) {
  if (selected.size && !selected.has(name)) continue;
  const start = performance.now();
  const { status, data } = await request("embed", { model, input, ...options });
  console.log(JSON.stringify({
    kind: "probe",
    name,
    utf16_units: input.length,
    utf8_bytes: encoder.encode(input).byteLength,
    ...options,
    status,
    prompt_eval_count: data.prompt_eval_count ?? null,
    dimensions: data.embeddings?.[0]?.length ?? null,
    embedding_sha256: await vectorHash(data.embeddings?.[0]),
    error: data.error ?? null,
    elapsed_ms: Math.round(performance.now() - start),
  }));
}
