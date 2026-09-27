import { assert, assertEquals, assertMatch } from "@std/assert";
import type { Fingerprint } from "../embedding-fingerprint.ts";
import { NOMIC_MANIFEST_DIGEST, NOMIC_MODEL } from "../nomic_pin.ts";
import {
  compare,
  decide,
  denoError,
  DRIFT_MIN_COSINE,
  type FingerprintRun,
  type Inputs,
  type ProbeRun,
  renderIssue,
  renderSummary,
} from "./ollama_early_warning_verdict.ts";

const meta = {
  pinned: {
    version: "0.34.1",
    image: "ollama/ollama:0.34.1@sha256:" + "a".repeat(64),
  },
  candidate: {
    version: "0.34.4",
    image: "ollama/ollama:0.34.4@sha256:" + "b".repeat(64),
  },
  model: { name: NOMIC_MODEL, digest: NOMIC_MANIFEST_DIGEST },
};

// Two short items and one three-passage document of 4-dimensional vectors.
function fingerprint(
  runtime: string,
  tweak?: (v: number[]) => number[],
): Fingerprint {
  const v = (seed: number) => {
    const vector = [seed, seed + 1, seed + 2, seed + 3].map((x) => x / 10);
    return tweak ? tweak(vector) : vector;
  };
  return {
    canary_set: "v1",
    runtime,
    model: NOMIC_MODEL,
    digest: NOMIC_MANIFEST_DIGEST,
    items: [
      { id: "upper", kind: "short", vectors: [v(1)] },
      { id: "lower", kind: "short", vectors: [v(2)] },
      { id: "prose", kind: "document", vectors: [v(3), v(4), v(5)] },
      // Same id as a short text: the kind must keep them apart.
      { id: "upper", kind: "document", vectors: [v(6), v(7)] },
    ],
  };
}

const ok = (fp: Fingerprint): FingerprintRun => ({ ok: true, fingerprint: fp });
const pass: ProbeRun = { exit: 0, lines: [{ stage: "resident" }], stderr: "" };
const fail = (stage: string, error: string): ProbeRun => ({
  exit: 1,
  lines: [{ stage: "identity" }, { stage }],
  stderr:
    `error: Uncaught (in promise) Error: ${error}\n    at file:///probe.ts:1:1\n`,
});

function inputs(overrides: {
  candidate?: FingerprintRun;
  control?: FingerprintRun;
  baseline?: FingerprintRun;
  pinnedProbe?: ProbeRun;
  candidateProbe?: ProbeRun;
} = {}): Inputs {
  return {
    meta,
    probes: {
      pinned: overrides.pinnedProbe ?? pass,
      candidate: overrides.candidateProbe ?? pass,
    },
    fingerprints: {
      baseline: overrides.baseline ?? ok(fingerprint("0.34.1")),
      control: overrides.control ?? ok(fingerprint("0.34.1")),
      candidate: overrides.candidate ?? ok(fingerprint("0.34.4")),
    },
  };
}

// Rotates a vector slightly in its first two coordinates.
const nudge = (amount: number) => (v: number[]) => [
  v[0] + amount,
  v[1] - amount,
  v[2],
  v[3],
];

Deno.test("identical candidate vectors are compatible and reported as bitwise identical", () => {
  const report = decide(inputs());
  assertEquals(report.verdict, "compatible");
  assertEquals(report.candidate?.min_cosine, 1);
  assertEquals(report.candidate?.passages, 7);
  assert(report.candidate?.identical);
  assertMatch(report.notes.join("\n"), /bitwise identical/);
});

Deno.test("a tiny numeric difference stays compatible but is noted", () => {
  const report = decide(
    inputs({ candidate: ok(fingerprint("0.34.4", nudge(1e-4))) }),
  );
  assertEquals(report.verdict, "compatible");
  assert(!report.candidate?.identical);
  assert((report.candidate?.min_cosine ?? 0) >= DRIFT_MIN_COSINE);
  assertMatch(report.notes.join("\n"), /not bitwise identical/);
});

Deno.test("vectors below the threshold are drift", () => {
  const report = decide(
    inputs({ candidate: ok(fingerprint("0.34.4", nudge(0.1))) }),
  );
  assertEquals(report.verdict, "drift");
  assert((report.candidate?.min_cosine ?? 1) < DRIFT_MIN_COSINE);
  assertMatch(
    report.reasons.join("\n"),
    /min cosine vs pinned .* below 0\.999/,
  );
});

Deno.test("a changed chunk count is drift even when every passage matches", () => {
  const candidate = fingerprint("0.34.4");
  const prose = candidate.items[2];
  if ("vectors" in prose) prose.vectors.push(prose.vectors[0]);
  const report = decide(inputs({ candidate: ok(candidate) }));
  assertEquals(report.verdict, "drift");
  assertEquals(report.candidate?.chunk_mismatches, [{
    id: "document/prose",
    pinned: 3,
    other: 4,
  }]);
  assertMatch(report.reasons.join("\n"), /document\/prose \(3 -> 4\)/);
});

Deno.test("mismatched dimensions rank as the worst score instead of passing", () => {
  const candidate = fingerprint("0.34.4", (v) => v.slice(0, 3));
  const report = decide(inputs({ candidate: ok(candidate) }));
  assertEquals(report.verdict, "drift");
  assertEquals(report.candidate?.min_cosine, -1);
});

Deno.test("a candidate failing the runtime probe is broken", () => {
  const report = decide(
    inputs({ candidateProbe: fail("accent", "Casing regression") }),
  );
  assertEquals(report.verdict, "broken");
  assertEquals(report.probe.candidate.failed_stage, "after accent");
  assertEquals(report.probe.candidate.error, "Error: Casing regression");
});

Deno.test("a candidate probe timeout is left to the next run", () => {
  const report = decide(inputs({
    candidateProbe: fail("prose", "Ollama embed timed out after 15000ms"),
  }));
  assertEquals(report.verdict, "error");
});

Deno.test("a candidate reporting a different digest for the same model is broken", () => {
  const candidate = fingerprint("0.34.4");
  candidate.digest = "f".repeat(64);
  const report = decide(inputs({
    candidate: ok(candidate),
    // The probe stops at the same mismatch; the contract reason must win.
    candidateProbe: fail(
      "identity",
      "Model digest differs from deployed artifact",
    ),
  }));
  assertEquals(report.verdict, "broken");
  assertMatch(report.reasons.join("\n"), /embedding contract would change/);
});

Deno.test("candidate embedding errors are broken", () => {
  const candidate = fingerprint("0.34.4");
  candidate.items[0] = {
    id: "upper",
    kind: "short",
    error: "Ollama embed failed: HTTP 500",
  };
  const report = decide(inputs({ candidate: ok(candidate) }));
  assertEquals(report.verdict, "broken");
  assertMatch(
    report.reasons.join("\n"),
    /candidate short upper: Ollama embed failed/,
  );
});

Deno.test("a crashed candidate fingerprint is broken unless the failure is transient", () => {
  assertEquals(
    decide(
      inputs({ candidate: { ok: false, error: "error: model not listed" } }),
    ).verdict,
    "broken",
  );
  assertEquals(
    decide(inputs({
      candidate: {
        ok: false,
        error: "error: endpoint identity changed while fingerprinting; retry",
      },
    })).verdict,
    "error",
  );
});

Deno.test("the harness refuses to judge when the pinned runtime fails its own probe", () => {
  const report = decide(
    inputs({ pinnedProbe: fail("casing", "Casing regression") }),
  );
  assertEquals(report.verdict, "error");
  assertMatch(report.reasons.join("\n"), /pinned runtime failed the probe/);
});

Deno.test("the harness refuses to judge when the control moves", () => {
  const report = decide(
    inputs({ control: ok(fingerprint("0.34.1", nudge(0.1))) }),
  );
  assertEquals(report.verdict, "error");
  assertMatch(report.reasons.join("\n"), /noise floor/);
  assertEquals(report.candidate, undefined);
});

Deno.test("the harness refuses to judge a pinned endpoint with the wrong identity", () => {
  const wrongDigest = fingerprint("0.34.1");
  wrongDigest.digest = "e".repeat(64);
  assertEquals(decide(inputs({ baseline: ok(wrongDigest) })).verdict, "error");
  assertEquals(
    decide(inputs({ control: ok(fingerprint("0.34.2")) })).verdict,
    "error",
  );
});

Deno.test("fingerprints of different canary sets are not compared", () => {
  const candidate = fingerprint("0.34.4");
  candidate.canary_set = "v2";
  assertEquals(decide(inputs({ candidate: ok(candidate) })).verdict, "error");
});

Deno.test("a candidate reporting the pinned version string is noted", () => {
  const report = decide(inputs({ candidate: ok(fingerprint("0.34.1")) }));
  assertEquals(report.verdict, "compatible");
  assertMatch(report.notes.join("\n"), /would not rerun its runtime canaries/);
});

Deno.test("compare reports items the candidate lacks", () => {
  const candidate = fingerprint("0.34.4");
  candidate.items = candidate.items.filter((item) => item.id !== "prose");
  const result = compare(fingerprint("0.34.1"), candidate);
  assertEquals(result.missing, ["document/prose"]);
  assert(!result.identical);
});

Deno.test("the drift threshold matches the relabel guard", async () => {
  Deno.env.set("DB_PASSWORD", "synthetic-test");
  Deno.env.set("MCP_ACCESS_KEY", "synthetic-test-key-".repeat(4));
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");
  const { RELABEL_MIN_COSINE } = await import(
    "../../server/embedding_backfill.ts"
  );
  assertEquals(DRIFT_MIN_COSINE, RELABEL_MIN_COSINE);
});

Deno.test("summaries name the verdict and the issue adds guidance only when needed", () => {
  const drift = decide(
    inputs({ candidate: ok(fingerprint("0.34.4", nudge(0.1))) }),
  );
  assertMatch(
    renderSummary(drift),
    /Ollama 0\.34\.4 vs pinned 0\.34\.1: \*\*drift\*\*/,
  );
  assertMatch(renderIssue(drift), /Do not bump the pinned image/);
  const compatible = decide(inputs());
  assertEquals(renderIssue(compatible), renderSummary(compatible));
});

Deno.test("Deno errors are extracted without terminal colors", () => {
  const stderr =
    "\x1b[0m\x1b[1m\x1b[31merror\x1b[0m: Uncaught (in promise) Error: embedding runtime: distinct-input canary collision; validate a corrected runtime before indexing\n      throw new Error(\n";
  assertEquals(
    denoError(stderr),
    "Error: embedding runtime: distinct-input canary collision; validate a corrected runtime before indexing",
  );
  assertEquals(denoError("no failure here\n"), undefined);
});

Deno.test("a broken report still shows how far the candidate vectors moved", () => {
  const report = decide(inputs({
    candidate: ok(fingerprint("0.24.0", nudge(0.1))),
    candidateProbe: fail(
      "identity",
      "embedding runtime: distinct-input canary collision",
    ),
  }));
  assertEquals(report.verdict, "broken");
  assert((report.candidate?.min_cosine ?? 1) < DRIFT_MIN_COSINE);
  assertMatch(renderSummary(report), /Lowest candidate passages/);
});
