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

| Family            | Local command                                 | Coverage                                                                      |
| ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| All corpus checks | `scripts/ci/run_db_init_smokes.sh all`        | CI-equivalent preflight plus every family below                               |
| Preflight         | `scripts/ci/run_db_init_smokes.sh preflight`  | Workflow paths, Funnel monitor, encrypted backup publication                  |
| Schema/data       | `scripts/ci/run_db_init_smokes.sh schema`     | Fresh-init shape, metadata upgrade, spaces, thought mutations, read-only dump |
| Auth              | `scripts/ci/run_db_init_smokes.sh auth`       | Native tokens, audit emitter, pre-1.20 upgrade, middleware seam               |
| Grants            | `scripts/ci/run_db_init_smokes.sh grants`     | Corpus role, membership, default-ACL, HBA, and retired-shape rejection        |
| Retirement        | `scripts/ci/run_db_init_smokes.sh retirement` | Archive gates, concurrency, restrictive drop, idempotency                     |
| Search            | `scripts/ci/run_db_init_smokes.sh search`     | Session HNSW/order plus thought-filter and hybrid plans                       |
| Summary           | `scripts/ci/run_db_init_smokes.sh summary`    | App-qube and Compose target-pinned summary wrappers                           |

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

| Family              | Local command                                 | Coverage                                                                                   |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| All log-sink checks | `scripts/ci/run_log_sink_smokes.sh all`       | CI-equivalent preflight plus every family below                                            |
| Preflight           | `scripts/ci/run_log_sink_smokes.sh preflight` | Role/credential mapping drift rejection plus ingress unit parsing and calendar             |
| Lifecycle           | `scripts/ci/run_log_sink_smokes.sh lifecycle` | Legacy status backfill, idempotency, assertion-gated adoption, and partial-init refusal    |
| Contract            | `scripts/ci/run_log_sink_smokes.sh contract`  | Generated status boundaries, marker, socket boundary, exact role grants, SCRAM, mutations  |
| Rollup              | `scripts/ci/run_log_sink_smokes.sh rollup`    | Shared projection, late arrivals, retention, concurrency, bounded sketches, closed catalog |
| Summary wrapper     | `scripts/ci/run_log_sink_smokes.sh wrapper`   | Target-pinned sink role, socket, SQL, database, retention, and report shape                |

Multiple primary-container families share one fresh fixture:

```sh
scripts/ci/run_log_sink_smokes.sh contract rollup wrapper
```

The lifecycle family owns separate adoption and failed-init volumes. Invoking a
checked-in `log_sink_*_smoke.sh` file directly bootstraps the corresponding
runner family.
