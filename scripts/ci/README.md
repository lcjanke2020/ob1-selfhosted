# Database CI smoke scripts

The corpus half of `.github/workflows/db-init.yml` is runnable outside GitHub
Actions through `run_db_init_smokes.sh`. The runner starts an ephemeral pgvector
container with the repository's real init mounts, runs the requested families,
and removes the container on success or failure.

## Prerequisites

Run from a checkout with Bash 4+, Docker, and Deno 2.9.x. The `summary` family
also requires `systemd-analyze`. Docker must be able to bind loopback port
55439; override it with `DB_SMOKE_PORT` when needed.

The runner anchors all paths to the checkout containing the script and pins its
loopback host, CI-only database names, and throwaway credentials rather than
inheriting deployment values from the caller's environment. It can therefore be
invoked by absolute path from outside the checkout; `DB_SMOKE_PORT` remains an
intentional caller override.

## Commands

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
