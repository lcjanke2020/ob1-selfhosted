// Synthetic, inference-only vector fingerprint of the pinned Nomic model on one
// Ollama endpoint. Comparing the fingerprints of two runtimes shows whether a
// release moves stored vectors (see scripts/ci/ollama_early_warning.sh). Uses
// the app's own embedder and passage chunker, so every request matches what the
// server sends, but supplies dummy app configuration and never connects to
// PostgreSQL. The canary texts are synthetic and contain no private data.
// Prints one JSON document to stdout. Example (from the repository root):
// OLLAMA_URL=http://127.0.0.1:11434 deno run --config server/deno.json --frozen \
//   --allow-env --allow-net=127.0.0.1:11434 scripts/embedding-fingerprint.ts
import { NOMIC_MODEL } from "./nomic_pin.ts";

// Bump when a text is added, removed or changed: fingerprints are compared by
// item id, and the verdict refuses to compare fingerprints of different sets.
export const CANARY_SET = "v1";

// Short texts take the query path: one strict request each.
export const SHORT_CANARIES: ReadonlyArray<readonly [string, string]> = [
  ["upper", "QUARTZ ZEPHYR WALRUS"],
  ["lower", "quartz zephyr walrus"],
  ["accent", "The café serves coffee."],
  ["plain", "The cafe serves coffee."],
  ["combining", "été café naïve"],
  ["pump", "Replace the basement sump pump before the spring thaw."],
  ["sheet", "Create a spreadsheet to track monthly household expenses."],
  ["query", "When should I prune apple trees?"],
  ["code", "function add(a, b) { return a + b; } // TODO: overflow check"],
  ["identifiers", "getHTTPResponseCode XMLHttpRequest snake_case_name"],
  [
    "path_uuid",
    "src/runtime/transport.ts 01234567-89ab-cdef-0123-456789abcdef",
  ],
  ["numbers", "Invoice 2026-09-27: 3 x $19.99 = $59.97 (tax 8.875%)"],
  ["url", "https://example.com/docs?page=2#section-3 user@example.org"],
  ["markdown", "## Next steps\n- [ ] rotate keys\n- [x] update docs"],
  ["toml", 'title = "Session"\nstatus = "active"\ntags = ["a", "b"]'],
  ["cjk", "中文测试：嵌入模型的稳定性检查。"],
  ["japanese", "埋め込みの安定性を確認します。"],
  ["cyrillic", "Проверка стабильности эмбеддингов."],
  ["greek", "Έλεγχος σταθερότητας ενσωματώσεων."],
  ["arabic", "اختبار ثبات التضمينات."],
  ["emoji", "👩🏽‍🚀 rocket launch 🚀 at dawn"],
  ["rare", "Zxqv plorth glimmerwick ⟁ ∮ ℵ₀"],
  ["whitespace", "  leading and trailing  \tspaces\n\nand lines  "],
  // Session sources reach the runtime NUL-joined (embedSource in
  // server/session_toml.ts).
  [
    "session_nul",
    "Fix the flaky test\0Find the race\0Added a lock\0Rerun CI",
  ],
  ["single", "a"],
  ["punctuation", "?!... --- ***"],
];

const common =
  "This log records routine maintenance work and notes for future reference. "
    .repeat(130);

// Documents take the passage path. Chunk counts show whether the runtime's
// tokenizer still splits them where the pinned one does.
export const DOCUMENT_CANARIES: ReadonlyArray<readonly [string, string]> = [
  ["prose", "A shared garden has fruit trees and flowers. ".repeat(260)],
  [
    "code",
    "src/runtime/transport.ts 01234567-89ab-cdef-0123-456789abcdef function(){return true;}\n"
      .repeat(120),
  ],
  ["cjk", "中文测试".repeat(1000)],
  ["combining", "é ".repeat(3000)],
  ["nonbmp", "👩🏽‍🚀 rocket ".repeat(700)],
  ["boundary2046", " a".repeat(2046)],
  ["boundary2047", " a".repeat(2047)],
  [
    "pump_late",
    common +
    "To replace the basement sump pump, disconnect power, remove the old pump, reconnect the discharge pipe and test the float switch.",
  ],
  [
    "session_long",
    [
      "Nightly maintenance",
      "Keep the shared garden records tidy. ".repeat(60),
      "Pruned the orchard and logged the pump test. ".repeat(80),
      "Next: order seed trays and check the float switch. ".repeat(40),
    ].join("\0"),
  ],
];

export type FingerprintItem =
  & { id: string; kind: "short" | "document" }
  & ({ vectors: number[][] } | { error: string });

export type Fingerprint = {
  canary_set: string;
  runtime: string;
  model: string;
  digest: string;
  items: FingerprintItem[];
};

if (import.meta.main) {
  Deno.env.set("DB_PASSWORD", "synthetic-fingerprint");
  Deno.env.set("MCP_ACCESS_KEY", "synthetic-fingerprint-key-".repeat(4));
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");
  Deno.env.set("EMBED_MODEL", NOMIC_MODEL);
  // Vectors are compared, not latency: a slow shared runner must not turn a
  // compatible runtime into a failure. The probe keeps production budgets.
  Deno.env.set("FETCH_TIMEOUT_MS", "120000");
  if (!Deno.env.get("OLLAMA_URL")?.trim()) {
    throw new Error("Set OLLAMA_URL to the isolated endpoint");
  }
  const { buildEmbeddingIndex } = await import("../server/embedding_index.ts");
  const { embed } = await import("../server/embeddings.ts");
  const { readEmbeddingIdentity } = await import(
    "../server/embedding_runtime.ts"
  );
  const deadline = () => ({ deadline: performance.now() + 300_000 });
  const before = await readEmbeddingIdentity(deadline());
  const items: FingerprintItem[] = [];
  for (const [id, text] of SHORT_CANARIES) {
    try {
      items.push({
        id,
        kind: "short",
        vectors: [await embed(text, deadline())],
      });
    } catch (e) {
      items.push({ id, kind: "short", error: (e as Error).message });
    }
  }
  for (const [id, text] of DOCUMENT_CANARIES) {
    try {
      const { deadline: end } = deadline();
      const index = await buildEmbeddingIndex(
        text,
        ["content"],
        embed,
        "fingerprint",
        end,
      );
      items.push({ id, kind: "document", vectors: index.vectors });
    } catch (e) {
      items.push({ id, kind: "document", error: (e as Error).message });
    }
  }
  const after = await readEmbeddingIdentity(deadline());
  if (after.runtime !== before.runtime || after.digest !== before.digest) {
    throw new Error("endpoint identity changed while fingerprinting; retry");
  }
  const fingerprint: Fingerprint = {
    canary_set: CANARY_SET,
    runtime: before.runtime,
    model: before.model,
    digest: before.digest,
    items,
  };
  console.log(JSON.stringify(fingerprint));
}
