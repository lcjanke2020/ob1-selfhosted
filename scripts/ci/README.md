# Database CI smoke scripts

Both database halves of `.github/workflows/db-init.yml` are runnable outside
GitHub Actions. Each runner anchors itself to the checkout containing the
script, pins CI-only fixture values, names the active family and invariant, and
removes its containers and volumes on success or failure.

## Corpus runner

### Prerequisites

Run from a checkout with Bash 4+, Docker, and Deno 2.9.x. The `summary` family
also requires `systemd-analyze`. Docker must be able to bind loopback port
55439; override it with `DB_SMOKE_PORT` when needed.

The runner anchors all paths to the checkout containing the script and pins its
loopback host, CI-only database names, and throwaway credentials rather than
inheriting deployment values from the caller's environment. It can therefore be
invoked by absolute path from outside the checkout; `DB_SMOKE_PORT` remains an
intentional caller override.

### Commands

| Family            | Local command                                 | Coverage                                                                                 |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| All corpus checks | `scripts/ci/run_db_init_smokes.sh all`        | CI-equivalent preflight plus every family below                                          |
| Preflight         | `scripts/ci/run_db_init_smokes.sh preflight`  | Workflow paths, Funnel monitor, encrypted backup publication                             |
| Schema/data       | `scripts/ci/run_db_init_smokes.sh schema`     | Fresh-init shape, metadata upgrade, spaces, thought mutations, read-only dump            |
| Auth              | `scripts/ci/run_db_init_smokes.sh auth`       | OAuth admission/import/rollback, native tokens, audit emitter, upgrades, middleware seam |
| Grants            | `scripts/ci/run_db_init_smokes.sh grants`     | Role attributes/membership, current/default PUBLIC ACLs, definer, HBA, retired shape     |
| Retirement        | `scripts/ci/run_db_init_smokes.sh retirement` | Archive gates, concurrency, restrictive drop, idempotency                                |
| Search            | `scripts/ci/run_db_init_smokes.sh search`     | Session HNSW/order plus thought-filter and hybrid plans                                  |
| Summary           | `scripts/ci/run_db_init_smokes.sh summary`    | App-qube and Compose target-pinned summary wrappers                                      |

Multiple families can share one fresh fixture:

```sh
scripts/ci/run_db_init_smokes.sh grants retirement
```

The documented runner form makes fixture ownership and multi-family reuse
explicit. Invoking an individual family file directly bootstraps the same runner
for that family.

## Log-sink runner

### Prerequisites

Run from a checkout with Bash 4+, Deno, Docker, the Docker Compose plugin, and
`systemd-analyze`. No host port is opened: the primary sink and every lifecycle
fixture use a Unix socket inside a `--network none` container. The image pin is
derived from the ingress-qube Compose file.

The runner ignores inherited deployment database names, credentials, images,
workspace paths, Compose project/file selectors, and container names. Local
scratch data stays under `RUNNER_TEMP`, `TMPDIR`, or a mode-0700 per-user
directory under `/tmp`.

### Commands

| Family              | Local command                                      | Coverage                                                                                                       |
| ------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| All log-sink checks | `scripts/ci/run_log_sink_smokes.sh all`            | CI-equivalent preflight plus every family below                                                                |
| Preflight           | `scripts/ci/run_log_sink_smokes.sh preflight`      | Role/credential mapping drift rejection plus ingress unit parsing and calendar                                 |
| Lifecycle           | `scripts/ci/run_log_sink_smokes.sh lifecycle`      | Legacy status backfill, idempotency, assertion-gated adoption, and partial-init refusal                        |
| Monitor absent      | `scripts/ci/run_log_sink_smokes.sh monitor-absent` | Fresh init without the optional monitor, assertion pass, PUBLIC-grant rejection, and same-name view rejection  |
| Contract            | `scripts/ci/run_log_sink_smokes.sh contract`       | Deployment gate, role attributes, exact grants, PUBLIC, socket/SCRAM, status boundaries                        |
| Rollup              | `scripts/ci/run_log_sink_smokes.sh rollup`         | Shared projection, late arrivals, retention, concurrency, bounded sketches, closed table/view/routine contract |
| Summary wrapper     | `scripts/ci/run_log_sink_smokes.sh wrapper`        | Target-pinned sink role, socket, SQL, database, retention, and report shape                                    |

Multiple primary-container families share one fresh fixture:

```sh
scripts/ci/run_log_sink_smokes.sh contract rollup wrapper
```

The lifecycle family owns separate adoption and failed-init volumes. Invoking a
checked-in `log_sink_*_smoke.sh` file directly bootstraps the corresponding
runner family.

## Ollama early-warning runner

`.github/workflows/ollama-early-warning.yml` tests each new Ollama release
against the image pinned in the Compose files, with the pinned Nomic model. The
workflow's scheduling, deduplication and notifications are described in
[embedding limits](../../docs/embedding-limits.md#early-warning-for-new-ollama-releases).
The measurement itself runs outside Actions.

### Prerequisites

Run from a checkout with Bash 4+, Docker, Deno 2.9.x, `jq` and `curl`, on Linux.
Each `ollama/ollama` image is about 3.7 GB compressed. The runner binds three
loopback ports starting at 55450; override the first with `EW_PORT_BASE`. Deno
runs with a minimal environment, so deployment settings in the caller's shell
cannot change the measurement.

### Commands

| Step       | Local command                                                                                                                   | Result                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Gate       | `scripts/ci/ollama_early_warning_gate.sh [VERSION]`                                                                             | Candidate image digest and evaluation key, or why no run is needed (needs `gh`, `docker buildx`)                   |
| A/B        | `scripts/ci/ollama_early_warning.sh ollama/ollama:VER@sha256:… DIR`                                                             | `DIR/verdict.json`, `summary.md`, `issue.md`, probe logs, fingerprints and container logs                          |
| Verdict    | `deno run --config server/deno.json --frozen --allow-read=DIR --allow-write=DIR scripts/ci/ollama_early_warning_verdict.ts DIR` | Recomputes the verdict from an existing result directory                                                           |
| Tests      | `deno test --config server/deno.json --frozen --allow-env --allow-read scripts/ci/ollama_early_warning_verdict_test.ts`         | Verdict rules on synthetic fingerprints                                                                            |
| Gate tests | `scripts/ci/ollama_early_warning_gate_test.sh`                                                                                  | Evaluation key, registry failures, pin digest, marker provenance and path coverage, with stubbed `gh` and `docker` |

Set `EW_MODEL_STORE` to a persistent directory to keep the verified model
between runs; by default it is downloaded into scratch space and removed. The
store is fetched with the pinned runtime and checked against the manifest digest
in `scripts/nomic_pin.ts`, then copied for each container. Passing the pinned
image as the candidate measures pinned against pinned, a quick end-to-end check
that should report `compatible` with bitwise-identical vectors.

The A/B exits 0 with a verdict about the candidate (`compatible`, `drift` or
`broken`) and 1 when the harness could not judge (`error`): the pinned runtime
failed its own probe, an endpoint served the wrong model, the pinned-vs-pinned
control moved, or a failure looked transient.
