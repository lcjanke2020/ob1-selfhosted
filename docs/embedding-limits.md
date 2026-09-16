# Embedding coverage, limits, and index migration

Server 1.28 indexes full supported thoughts and session embedding fields as
passages. Each thought/session remains **one canonical record**, with its
original ID, full content or TOML, and artifacts. Chunks are dependent index
data; lookup and search never return separate passage records.

## Source and retrieval contract

Thoughts embed their complete stored content. Fingerprint deduplication still
retains the original canonical text, including its original case/whitespace;
recapture embeds that retained text. Content updates embed the full replacement.
Session source is `title`, `goal`, `summary`, `resume_context`, in that order,
joined by three NUL delimiters. Arrays, artifacts, repository, branch and other
fields remain stored and **are not embedded**. SHA-256 covers the entire
selected source, including text beyond the old 8000 UTF-16-unit prefix.

Version `passages-v1-no-prefix` uses unmodified text and no task prefixes. The
model's special tokens count against its context automatically: every request
uses `truncate:false`. The first split targets 4096 UTF-16 units at grapheme
boundaries. This is a request-size heuristic, **not a token guarantee**. Only
HTTP 400 with the exact Ollama context-overflow error causes recursive
splitting. No other error is retried. A single grapheme longer than the initial
target is tested intact against the model. A grapheme that cannot fit is
rejected; surrogate pairs, combining sequences and emoji clusters are never
split.

The index stores separate passage vectors in one vector-array row per parent.
Search scores a record by its **maximum passage cosine similarity**, then ranks
distinct canonical IDs. This preserves late-passage matches without multiplying
results. Pooling was rejected for this contract: for orthogonal synthetic
passages, one distinctive passage among many unrelated passages has best-passage
cosine 1, while their average approaches the unrelated direction. This explains
the choice; it is not a model-quality measurement. Maximum similarity can favor
longer documents with more chances to match, which requires corpus evaluation.

Initial passage retrieval uses exact distance scoring, with a transaction-local
5-second SQL statement timeout. It scans eligible passage vectors and groups
before limiting records; `LIMIT` bounds returned candidates, not database work.
It does not use the legacy HNSW indexes. Thought lexical parsing, negative-term
gates, trigram fallback, provenance filters and RRF remain as described in
[hybrid search](hybrid-search.md). The vector leg ranks canonical records before
fusion. Session filters apply before passage scoring. Search uses a repeatable
read transaction so readiness and retrieval observe one corpus snapshot.

Search queries have one embedding. A query that exceeds the actual model context
is rejected with a validation error asking for a shorter query. Queries are
never truncated, split into an OR, or silently changed before lexical parsing.

## Bounds and reporting

| Stage                               | Bound and outcome                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Thought content / full session TOML | 100,000 UTF-8 bytes each; rejected before embedding if oversized                                                                         |
| Selected embedding source           | 100,000 UTF-8 bytes; malformed Unicode rejected                                                                                          |
| Query text                          | 8192 UTF-8 bytes and one strict model-context fit; byte fit alone does not promise token fit                                             |
| Initial document passage            | Target 4096 UTF-16 units at a grapheme boundary; overflow splits further                                                                 |
| One document index                  | At most 128 successful chunks and 255 embedding attempts                                                                                 |
| Embedding job                       | 15 seconds total for source embedding plus runtime/model checks; each HTTP request also respects `FETCH_TIMEOUT_MS` (default 15 seconds) |
| Concurrency                         | Two embedding jobs and at most two embedding HTTP requests per process; overload rejects without an unbounded queue                      |
| Upstream response                   | 64 KiB embedding JSON; 8 KiB error body; 256 KiB identity response                                                                       |
| SQL search                          | 5 seconds per statement; exact scan costs grow with visible passage count                                                                |
| Authenticated HTTP body             | 1 MiB for REST/MCP; source-field limits apply inside that envelope                                                                       |
| MCP result                          | 120,000 serialized UTF-8 bytes, including JSON escaping; oversized results report omissions and recovery guidance                        |

Canonical records remain complete even when the MCP serialization budget
requires field omission; use the reported REST recovery path to retrieve the
full record.

The 100,000-byte bound is an admission ceiling, not a promise that every input
below it finishes. The model's throughput, token density, cold-load time and
concurrent load determine how much text fits into the 15-second job budget. That
budget is a compile-time constant; raising `FETCH_TIMEOUT_MS` does not raise it.
A slower backend can reject a smaller document on deadline, before any
canonical/index write. Size the maintenance window from representative
measurements rather than the byte ceiling.

A successful embedding covers the complete selected source. Capture and changed
thought updates return `embedding_coverage` (MCP thought capture includes it in
its text result): `complete`, contributing `fields`, `utf8_bytes`,
`utf16_units`, `chunks`, and `contract`. Session refreshes that reuse an
unchanged index omit this optional field and return `reembedded:false`.

Embedding errors identify document/query stage, contributing fields, measured
UTF-8 bytes and UTF-16 units, and `write=not_started` or `search=not_started`.
HTTP status, timeout and context overflow are distinct; upstream error bodies
are never echoed. REST uses 400 for a context-overflow query and 502 for
upstream failure; MCP returns a tool error. A transport timeout after a request
was sent still has an **unknown** write outcome: reconcile by lookup before
retrying.

All required vectors exist before the canonical write begins. Canonical fields,
passage vectors, artifacts, revisions and degradation events commit together. A
failed chunk writes nothing; a failed index write rolls the transaction back.
Unchanged session refreshes recheck their source/contract under the parent lock,
so a concurrent edit cannot pair old vectors with new fields. Source-changing
SQL or an old writer invalidates the dependent index in the same transaction.

The index uses forced parent-gated RLS. A thought move changes the parent
audience and immediately changes vector visibility; owner deletion cascades. No
copied workspace/owner fields can drift from the canonical row.

## Runtime identity and the known tokenizer defect

The embedding contract hashes strategy version, model name, model manifest
digest, dimensions and reported Ollama runtime version. Both document and query
paths verify that identity before/after work. Sessions reuse an index only when
its full-source hash and contract both match. Rebuild the whole corpus for a
model/runtime/prefix/strategy change; a mutable model tag is insufficient.

A distinct-input canary rejects the uppercase collision reproduced in the
[September investigation](investigations/2026-09-16-embedding-context-overflow.md).
This detects that particular corruption; it does not certify arbitrary tokenizer
behavior. Custom runtime builds must expose a distinct version, and the backend
must remain immutable during service operation. Before any rollout, separately
validate the selected runtime/model with casing, unknown-token, multilingual,
boundary and representative retrieval probes. Nomic's
[model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5#usage)
recommends task prefixes; introducing them is a separate, versioned contract
change requiring retrieval evaluation and another rebuild.

The tested Ollama 0.24.0 runtime still fails the canary. Read-only tests of
strict chunk **fit** succeeded for prose, code/UUIDs, CJK, combining characters,
emoji, and the measured boundary; see
[recorded results](investigations/2026-09-16-chunk-fit.jsonl). Those results do
not validate search quality or make that defective runtime deployable. The
original historically rejected session payload was not recovered; synthetic
fixtures do not claim byte-for-byte incident replay.

### Tested replacement: Ollama 0.34.1

Ollama **0.34.1** passed an isolated CPU test on Linux amd64 with the **same
Nomic model manifest** as the deployment. Both Compose stacks now pin the
multi-platform image index
`sha256:0c0a83210471fb50226bcdc2d6611d20ab13ae87e024cc304c94a6a5765c5e65`. The
tested amd64 manifest is
`sha256:8eb6c4d16138c8320f2598f03e01b3549f6ed2e41fe6ac16329a5a921b314914`; arm64
was not tested. This is a tested replacement candidate, not a statement that
production has been upgraded.

The actual app runtime gate passed. Upper/lowercase versions of the same phrase
had cosine 1; unrelated uppercase phrases were distinct (cosine about 0.252).
The accent-normalization pair also matched. The effective context remained 2048
tokens: 2046 repetitions plus special tokens fitted, while 2047 were rejected in
strict mode. All seven chunk-fit cases completed inside the 15-second budget in
this fixture. Three synthetic retrieval checks ranked the intended document
first using its final passage. These are bounded smoke tests, not a multilingual
or corpus-wide quality certification, nor a latency guarantee on another host.

See the
[recorded results](investigations/2026-09-16-ollama-0341-validation.jsonl) and
[reusable probe](../scripts/probe-embedding-runtime.ts). The upstream
[uppercase issue](https://github.com/ollama/ollama/issues/13942#issuecomment-4617769764)
already reported corrected behavior in 0.30.0/0.30.3. The still-open truncation
PR is not a prerequisite for our strict chunking path. Before cutover, repeat
the checks on the target CPU and evaluate representative approved records. Do
not upgrade the runtime beneath an app serving the old vectors: schedule
runtime, full-corpus rebuild, and app activation as one maintenance operation.

## Reviewed offline migration and cutover

This change does not automatically migrate, backfill or deploy an existing
installation. Fresh databases also need an activated generation, even when
empty. Operator approval of the migration and rollout is separate from code
review.

1. Back up the corpus and preserve the old app/runtime images. Stop all writers
   and search consumers for maintenance. Validate the chosen corrected runtime
   and keep its model manifest and version immutable.
2. Apply `db/15-embedding-index.sql` as a PostgreSQL superuser after migrations
   01–14, then run `db/03-grants-assertion.sql`. Existing canonical records and
   legacy vectors are retained; the migration initializes no active generation.
3. Run `server/embedding_backfill.ts` in the new app checkout/image with an
   explicitly selected **PostgreSQL superuser** connection and the validated
   Ollama backend. This tool checks `rolsuper`; database ownership or BYPASSRLS
   alone is not supported. Never inherit the request server's `openbrain_app`
   credentials. Planning is **read-only by default** and reports the contract
   and counts needing rebuild without printing payloads. Use the
   [Compose runner below](#compose-backfill-runner), also for the Qubes app
   service. A direct Deno invocation must supply the same `DB_*` superuser
   connection plus the existing required auth/model/privacy settings from
   `server/config.ts`; the tool shares that configuration but starts no server.

4. Review the plan and runtime evidence, then explicitly run the same command
   with `--apply`. The tool reads one canonical row at a time, computes all its
   vectors, and commits its index under a parent lock with full-source hash
   verification. It never creates replacement canonical records or rewrites
   session artifacts/timestamps. It skips matching source/contract pairs on
   rerun. Legacy session `content_hash` becomes the full-source hash on the next
   ordinary refresh; the new index's `source_hash` is authoritative meanwhile.
5. After every canonical record has an index, the tool locks both canonical
   tables, checks full coverage, and activates the contract atomically. Any
   unsupported input, failed embedding, source race or identity drift prevents
   activation. A partially completed backfill can resume; it is not a usable
   mixed-generation search index. Keep the service offline throughout.
6. Start server 1.28 with the same runtime/model. Startup and every search fail
   closed unless the active contract and the entire corpus agree. Verify a
   long-record capture, late-passage search, scoped lookup and failed refresh
   using approved fixtures before ending maintenance.

Backfill commits per record, not per corpus. If it fails, keep maintenance in
place and resume or restore the pre-migration backup and old images. Do not
declare a generation active manually or fall back to searching a mixture. After
new-version writes, an app-only rollback is insufficient; restore the
coordinated corpus/runtime/app backup or conduct a separately reviewed reverse
rebuild.

### Compose backfill runner

Use this for a **fresh empty database too**: migration 15 creates an inactive
generation and `--apply` activates it only after checking coverage. Starting MCP
before activation fails its startup gate. For an upgrade, keep MCP and all other
corpus writers/search consumers stopped throughout this procedure.

First complete migrations 01–15 and the final grants assertion, start only the
database and validated embedding backend, and build the new `mcp` image. Run the
block below from the deployment's Compose directory. Local Compose uses
`deploy/compose-local`; Pattern B uses `deploy/compose-tailnet` with its
existing `COMPOSE_FILE`/`COMPOSE_PROFILES` settings; Qubes uses
`deploy/qubes/app-qube` and its existing database forwarder. Confirm `DB_HOST`,
`DB_PORT`, `DB_NAME`, `OLLAMA_URL` and model selection target the intended
corpus/runtime.

The example uses the standard corpus superuser `postgres`. If renamed, replace
`DB_USER=postgres` with that superuser's name. Enter its current password (the
corpus `POSTGRES_PASSWORD`, not the app or log-sink password). The temporary
container inherits the app's normal configuration with **only its database
identity overridden**. `--no-deps` prevents it from starting MCP/dependencies,
and `run` does not publish the service's ports. The password leaves the shell
when the subshell exits and is not written into the app's configuration.

```bash
(
set -euo pipefail
read -r -s -p 'Corpus PostgreSQL superuser password: ' DB_PASSWORD
printf '\n'
export DB_PASSWORD
docker compose --env-file .env run --rm --no-deps -T \
  -e DB_USER=postgres -e DB_PASSWORD mcp \
  deno run --cached-only --frozen --allow-env --allow-net embedding_backfill.ts

# Review the plan, backup, validated runtime and stopped-writer state first.
read -r -p 'Apply the reviewed rebuild and activate it? Type rebuild: ' rebuild_review
test "$rebuild_review" = rebuild
docker compose --env-file .env run --rm --no-deps -T \
  -e DB_USER=postgres -e DB_PASSWORD mcp \
  deno run --cached-only --frozen --allow-env --allow-net embedding_backfill.ts --apply
)
```

Require successful exit and the final `activated` record before starting MCP.
Failure leaves the service in maintenance; correct the cause and rerun with the
same immutable runtime/model. Matching records are reused. Then return to the
deployment guide's MCP start and smoke checks. Do not start an old app with the
corrected runtime against its old vectors, or present this offline tool as an
online background migration.
