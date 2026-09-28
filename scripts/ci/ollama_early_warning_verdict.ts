// Decides the Ollama early-warning verdict from one runner directory written by
// scripts/ci/ollama_early_warning.sh, and writes verdict.json, summary.md and
// issue.md next to its inputs. Exit status: 0 for a verdict about the candidate
// (compatible, drift or broken), 1 when the harness could not judge (error).
//   deno run --config server/deno.json --frozen --allow-read=DIR \
//     --allow-write=DIR scripts/ci/ollama_early_warning_verdict.ts DIR
import { cosine } from "../../server/embedding_index.ts";
import type { Fingerprint } from "../embedding-fingerprint.ts";

// Same bar as the relabel guard (RELABEL_MIN_COSINE in
// server/embedding_backfill.ts): below it, stored vectors no longer count as
// produced by the runtime at hand, and a deployment check would flag them.
export const DRIFT_MIN_COSINE = 0.999;
const LOWEST_REPORTED = 5;

export type Verdict = "compatible" | "drift" | "broken" | "error";

export type Meta = {
  pinned: { version: string; image: string };
  candidate: { version: string; image: string };
  model: { name: string; digest: string };
  runner?: { arch: string; cpu: string; cpus: number };
  run_url?: string;
};

export type ProbeRun = {
  exit: number;
  lines: Record<string, unknown>[];
  stderr: string;
};

export type FingerprintRun =
  | { ok: true; fingerprint: Fingerprint }
  | { ok: false; error: string };

export type Inputs = {
  meta: Meta;
  probes: { pinned: ProbeRun; candidate: ProbeRun };
  fingerprints: {
    baseline: FingerprintRun;
    control: FingerprintRun;
    candidate: FingerprintRun;
  };
};

export type Comparison = {
  items: number;
  passages: number;
  min_cosine: number | null;
  identical: boolean;
  chunk_mismatches: { id: string; pinned: number; other: number }[];
  missing: string[];
  lowest: { id: string; passage: number; cosine: number }[];
};

type ProbeSummary = {
  pass: boolean;
  failed_stage?: string;
  error?: string;
};

export type Report = {
  schema: 1;
  verdict: Verdict;
  reasons: string[];
  notes: string[];
  threshold: number;
  meta: Meta;
  runtimes: { baseline?: string; control?: string; candidate?: string };
  probe: { pinned: ProbeSummary; candidate: ProbeSummary };
  control?: Comparison;
  candidate?: Comparison;
  // For broken: whether a deployed 1.29+ server itself rejects this runtime
  // (its canaries, contract or failing requests), or only the probe noticed.
  enforced?: boolean;
};

// Failures that say nothing about the candidate's vectors: a stalled shared
// runner or a runtime swap mid-run. They leave the verdict to the next run.
const TRANSIENT =
  /timed out|deadline exceeded|backend busy|identity changed|changed while/i;

// The first `error:` line of a Deno failure, without terminal colors.
export function denoError(stderr: string): string | undefined {
  // deno-lint-ignore no-control-regex
  const plain = stderr.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.split("\n").map((l) => l.trim()).find((l) =>
    l.startsWith("error:")
  )?.replace(/^error:\s*(Uncaught\s*(\(in promise\)\s*)?)?/, "");
}

// The runtime version the probe's identity stage read from its endpoint.
function probeRuntime(run: ProbeRun): string | undefined {
  const runtime = run.lines.find((l) => l.stage === "identity")?.runtime;
  return typeof runtime === "string" ? runtime : undefined;
}

// Failure messages of checks the server itself performs before using vectors:
// its runtime canaries and its model identity.
const SERVER_ENFORCED = /^Error: (embedding runtime:|Model digest differs)/;

export function summarizeProbe(run: ProbeRun): ProbeSummary {
  if (run.exit === 0) return { pass: true };
  const last = run.lines.at(-1);
  const stage = last && (last.stage ?? last.name);
  const message = denoError(run.stderr);
  return {
    pass: false,
    ...(typeof stage === "string" ? { failed_stage: `after ${stage}` } : {}),
    error: (message || `exit ${run.exit}`).slice(0, 300),
  };
}

export function compare(pinned: Fingerprint, other: Fingerprint): Comparison {
  // Short texts and documents may share an id; the kind is part of the key.
  const key = (item: { kind: string; id: string }) => `${item.kind}/${item.id}`;
  const byKey = new Map(other.items.map((item) => [key(item), item]));
  const scores: Comparison["lowest"] = [];
  const chunkMismatches: Comparison["chunk_mismatches"] = [];
  const missing: string[] = [];
  let items = 0;
  let identical = true;
  for (const item of pinned.items) {
    if (!("vectors" in item)) continue;
    const match = byKey.get(key(item));
    if (!match || !("vectors" in match)) {
      missing.push(key(item));
      identical = false;
      continue;
    }
    items++;
    if (match.vectors.length !== item.vectors.length) {
      chunkMismatches.push({
        id: key(item),
        pinned: item.vectors.length,
        other: match.vectors.length,
      });
      identical = false;
      continue;
    }
    item.vectors.forEach((vector, passage) => {
      const theirs = match.vectors[passage];
      if (
        vector.length !== theirs.length ||
        vector.some((x, i) => x !== theirs[i])
      ) identical = false;
      const similarity = cosine(vector, theirs);
      // NaN (mismatched dimensions) ranks as the worst possible score.
      scores.push({
        id: key(item),
        passage,
        cosine: Number.isNaN(similarity) ? -1 : similarity,
      });
    });
  }
  scores.sort((a, b) => a.cosine - b.cosine);
  return {
    items,
    passages: scores.length,
    min_cosine: scores[0]?.cosine ?? null,
    identical,
    chunk_mismatches: chunkMismatches,
    missing,
    lowest: scores.slice(0, LOWEST_REPORTED),
  };
}

const moved = (c: Comparison) =>
  c.chunk_mismatches.length > 0 || c.missing.length > 0 ||
  c.min_cosine === null || c.min_cosine < DRIFT_MIN_COSINE;

function itemErrors(fingerprint: Fingerprint): string[] {
  return fingerprint.items.flatMap((item) =>
    "error" in item ? [`${item.kind} ${item.id}: ${item.error}`] : []
  );
}

export function decide(inputs: Inputs): Report {
  const { meta, probes, fingerprints } = inputs;
  const reasons: string[] = [];
  const notes: string[] = [];
  const report: Report = {
    schema: 1,
    verdict: "error",
    reasons,
    notes,
    threshold: DRIFT_MIN_COSINE,
    meta,
    runtimes: {},
    probe: {
      pinned: summarizeProbe(probes.pinned),
      candidate: summarizeProbe(probes.candidate),
    },
  };
  const done = (verdict: Verdict) => {
    report.verdict = verdict;
    return report;
  };

  // 1. Can the harness judge at all? The pinned runtime, measured twice, must
  // pass the probe, report the pinned identity and agree with itself.
  const baseline = fingerprints.baseline;
  const control = fingerprints.control;
  if (!baseline.ok) {
    reasons.push(`pinned fingerprint failed: ${baseline.error}`);
  }
  if (!control.ok) reasons.push(`control fingerprint failed: ${control.error}`);
  if (!baseline.ok || !control.ok) return done("error");
  report.runtimes.baseline = baseline.fingerprint.runtime;
  report.runtimes.control = control.fingerprint.runtime;
  for (
    const [name, run] of [["pinned", baseline], ["control", control]] as const
  ) {
    const fp = run.fingerprint;
    if (fp.digest !== meta.model.digest) {
      reasons.push(
        `${name} endpoint serves model digest ${fp.digest}, not the pin`,
      );
    }
    if (fp.runtime !== meta.pinned.version) {
      reasons.push(
        `${name} endpoint reports runtime ${fp.runtime}, not ${meta.pinned.version}`,
      );
    }
    reasons.push(...itemErrors(fp).map((e) => `${name} ${e}`));
  }
  if (!report.probe.pinned.pass) {
    reasons.push(
      `the pinned runtime failed the probe on this runner: ${report.probe.pinned.error}`,
    );
  } else if (probeRuntime(probes.pinned) !== baseline.fingerprint.runtime) {
    // The probe and the fingerprint must have measured the same endpoint.
    reasons.push(
      `the pinned probe read runtime ${
        probeRuntime(probes.pinned)
      } but the pinned fingerprint ${baseline.fingerprint.runtime}`,
    );
  }
  if (reasons.length) return done("error");
  report.control = compare(baseline.fingerprint, control.fingerprint);
  if (moved(report.control)) {
    reasons.push(
      `pinned-vs-pinned control moved (min cosine ${report.control.min_cosine}, ${report.control.chunk_mismatches.length} chunk mismatches); the noise floor is above the threshold`,
    );
    return done("error");
  }

  // 2. Does the candidate still work the way the server requires?
  const transient = (message: string) => TRANSIENT.test(message);
  const candidate = fingerprints.candidate;
  if (candidate.ok) {
    const fp = candidate.fingerprint;
    report.runtimes.candidate = fp.runtime;
    if (fp.canary_set !== baseline.fingerprint.canary_set) {
      reasons.push(
        `canary sets differ (${baseline.fingerprint.canary_set} vs ${fp.canary_set})`,
      );
      return done("error");
    }
    // A harness that fingerprints the wrong endpoint would compare the pin
    // with itself and call every release compatible. The probe's identity
    // stage must have seen the same runtime as the candidate fingerprint.
    const seen = probeRuntime(probes.candidate);
    if (
      (report.probe.candidate.pass || seen !== undefined) && seen !== fp.runtime
    ) {
      reasons.push(
        `the candidate probe read runtime ${seen} but the candidate fingerprint ${fp.runtime}`,
      );
      return done("error");
    }
    if (fp.runtime !== meta.candidate.version) {
      notes.push(
        `candidate image reports runtime ${fp.runtime}, not ${meta.candidate.version}`,
      );
    }
    if (fp.runtime === meta.pinned.version) {
      notes.push(
        "candidate reports the pinned version string, so a deployed server would not rerun its runtime canaries after this upgrade",
      );
    }
    // Shows how far the vectors moved, also when the candidate is broken.
    report.candidate = compare(baseline.fingerprint, fp);
    // Checked before the probe, which stops at the same mismatch with a less
    // useful message.
    if (fp.digest !== meta.model.digest) {
      reasons.push(
        `candidate reports model digest ${fp.digest} for the same model files; the server's embedding contract would change and every capture and search would fail closed until a full rebuild`,
      );
      report.enforced = true;
      return done("broken");
    }
  }
  const probe = report.probe.candidate;
  if (!probe.pass) {
    reasons.push(
      `candidate failed the runtime probe (${
        probe.failed_stage ?? "before any stage"
      }): ${probe.error}`,
    );
    report.enforced = SERVER_ENFORCED.test(probe.error ?? "");
    return done(transient(probe.error ?? "") ? "error" : "broken");
  }
  // Failing identity reads and embedding requests fail the server's own
  // captures and searches as well.
  if (!candidate.ok) {
    reasons.push(`candidate fingerprint failed: ${candidate.error}`);
    report.enforced = true;
    return done(transient(candidate.error) ? "error" : "broken");
  }
  const errors = itemErrors(candidate.fingerprint);
  if (errors.length) {
    reasons.push(...errors.map((e) => `candidate ${e}`));
    report.enforced = true;
    return done(errors.every(transient) ? "error" : "broken");
  }

  // 3. Do its vectors still match the pinned ones?
  const c = compare(baseline.fingerprint, candidate.fingerprint);
  if (c.chunk_mismatches.length) {
    reasons.push(
      `chunk counts differ for ${
        c.chunk_mismatches.map((m) => `${m.id} (${m.pinned} -> ${m.other})`)
          .join(", ")
      }: the tokenizer or context accounting changed`,
    );
  }
  if (c.missing.length) {
    reasons.push(`candidate is missing items ${c.missing.join(", ")}`);
  }
  if (c.min_cosine === null || c.min_cosine < DRIFT_MIN_COSINE) {
    reasons.push(
      `min cosine vs pinned ${c.min_cosine} is below ${DRIFT_MIN_COSINE} (lowest: ${
        c.lowest.map((l) => `${l.id}#${l.passage}`).join(", ")
      })`,
    );
  }
  if (reasons.length) return done("drift");
  notes.push(
    c.identical
      ? "every candidate vector is bitwise identical to the pinned one"
      : `vectors are not bitwise identical; min cosine ${c.min_cosine}`,
  );
  return done("compatible");
}

const short = (image: string) =>
  image.replace(/(@sha256:[0-9a-f]{12})[0-9a-f]+$/, "$1…");
const fmt = (x: number | null | undefined) =>
  x === null || x === undefined ? "n/a" : x === 1 ? "1" : x.toFixed(6);

export function renderSummary(report: Report): string {
  const { meta } = report;
  const probe = (p: ProbeSummary) =>
    p.pass ? "pass" : `**fail** ${p.failed_stage ?? ""}: ${p.error ?? ""}`;
  const lines = [
    `## Ollama ${meta.candidate.version} vs pinned ${meta.pinned.version}: **${report.verdict}**`,
    "",
    "| | Pinned | Candidate |",
    "| --- | --- | --- |",
    `| Version | ${meta.pinned.version} | ${meta.candidate.version} |`,
    `| Image | \`${short(meta.pinned.image)}\` | \`${
      short(meta.candidate.image)
    }\` |`,
    `| Reported runtime | ${report.runtimes.baseline ?? "n/a"} | ${
      report.runtimes.candidate ?? "n/a"
    } |`,
    `| Runtime probe | ${probe(report.probe.pinned)} | ${
      probe(report.probe.candidate)
    } |`,
    "",
    `Model \`${meta.model.name}\`, manifest \`${
      meta.model.digest.slice(0, 12)
    }…\`. Threshold: cosine ${report.threshold} per passage and equal chunk counts.`,
    "",
  ];
  const row = (name: string, c?: Comparison) =>
    c
      ? `| ${name} | ${c.items} / ${c.passages} | ${fmt(c.min_cosine)} | ${
        c.identical ? "yes" : "no"
      } | ${c.chunk_mismatches.length} |`
      : `| ${name} | not compared | | | |`;
  lines.push(
    "| Comparison | Items / passages | Min cosine | Bitwise identical | Chunk mismatches |",
    "| --- | --- | --- | --- | --- |",
    row("Control (pinned vs pinned)", report.control),
    row("Candidate vs pinned", report.candidate),
    "",
  );
  if (report.candidate && !report.candidate.identical) {
    lines.push(
      "Lowest candidate passages: " +
        report.candidate.lowest.map((l) =>
          `${l.id}#${l.passage} ${fmt(l.cosine)}`
        ).join(", "),
      "",
    );
  }
  if (report.reasons.length) {
    lines.push("**Reasons**", "", ...report.reasons.map((r) => `- ${r}`), "");
  }
  if (report.notes.length) {
    lines.push("**Notes**", "", ...report.notes.map((n) => `- ${n}`), "");
  }
  const runner = meta.runner
    ? ` (${meta.runner.arch}, ${meta.runner.cpu}, ${meta.runner.cpus} CPUs)`
    : "";
  lines.push(
    `Both images ran CPU inference on the same Linux machine${runner}, so CPU backend differences cancel. Other platforms, such as macOS with Metal or a GPU, can still differ.`,
  );
  if (meta.run_url) lines.push("", `Run: ${meta.run_url}`);
  return lines.join("\n") + "\n";
}

const HEADING = "### What this means\n\n";
const HOLD =
  "Hold or roll back any deployment that upgrades Ollama automatically.";

function guidance(report: Report): string | undefined {
  if (report.verdict === "drift") {
    return HEADING + [
      "This release changes the vectors of the pinned model. Do not bump the pinned image to it yet.",
      "A deployment that already runs it (for example a native install upgraded by device management) keeps accepting writes, but new vectors no longer line up with stored ones and ranking degrades without any error.",
      "Check such deployments, then recover with `embedding_backfill.ts --rebuild` or roll the runtime back (docs/embedding-limits.md, *Recovering from runtime drift*).",
    ].join("\n");
  }
  if (report.verdict !== "broken") return undefined;
  if (report.enforced) {
    return HEADING + [
      "This release fails a check the server itself performs. Do not bump the pinned image to it.",
      "A server 1.29+ deployment that upgrades to it fails closed: its runtime canaries, embedding contract or failing embedding requests reject captures and searches (`write=not_started`) until the runtime is rolled back or fixed.",
      HOLD,
    ].join("\n");
  }
  return HEADING + [
    `This release fails a probe check that the server does not enforce (${
      report.probe.candidate.failed_stage ?? "probe"
    }). Do not bump the pinned image to it.`,
    "A server 1.29+ deployment that upgrades to it keeps accepting captures and searches. Depending on the check, passages no longer split at the context boundary the chunker relies on, or late passages stop ranking, so treat those deployments as drifted: check them and rebuild or roll the runtime back.",
    HOLD,
  ].join("\n");
}

export function renderIssue(report: Report): string {
  const text = guidance(report);
  return renderSummary(report) + (text ? `\n${text}\n` : "");
}

async function readProbe(dir: string, name: string): Promise<ProbeRun> {
  const read = (suffix: string) =>
    Deno.readTextFile(`${dir}/probe-${name}.${suffix}`).catch(() => "");
  const lines = (await read("jsonl")).split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" ? [value] : [];
    } catch {
      return [];
    }
  });
  const exit = Number.parseInt((await read("status")).trim(), 10);
  return {
    exit: Number.isInteger(exit) ? exit : -1,
    lines,
    stderr: await read("stderr"),
  };
}

async function readFingerprint(
  dir: string,
  name: string,
): Promise<FingerprintRun> {
  const path = `${dir}/fp-${name}`;
  const status = (await Deno.readTextFile(`${path}.status`).catch(() => ""))
    .trim();
  const stderr = await Deno.readTextFile(`${path}.stderr`).catch(() => "");
  if (status !== "0") {
    const message = denoError(stderr) ?? `exit ${status || "unknown"}`;
    return { ok: false, error: message.slice(0, 300) };
  }
  try {
    return {
      ok: true,
      fingerprint: JSON.parse(await Deno.readTextFile(`${path}.json`)),
    };
  } catch (e) {
    return { ok: false, error: `unreadable: ${(e as Error).message}` };
  }
}

if (import.meta.main) {
  const dir = Deno.args[0];
  if (!dir) {
    console.error("usage: ollama_early_warning_verdict.ts RESULT_DIR");
    Deno.exit(2);
  }
  const meta: Meta = JSON.parse(await Deno.readTextFile(`${dir}/meta.json`));
  const report = decide({
    meta,
    probes: {
      pinned: await readProbe(dir, "pinned"),
      candidate: await readProbe(dir, "candidate"),
    },
    fingerprints: {
      baseline: await readFingerprint(dir, "baseline"),
      control: await readFingerprint(dir, "control"),
      candidate: await readFingerprint(dir, "candidate"),
    },
  });
  await Deno.writeTextFile(
    `${dir}/verdict.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  await Deno.writeTextFile(`${dir}/summary.md`, renderSummary(report));
  await Deno.writeTextFile(`${dir}/issue.md`, renderIssue(report));
  console.log(
    JSON.stringify({ verdict: report.verdict, reasons: report.reasons }),
  );
  Deno.exit(report.verdict === "error" ? 1 : 0);
}
