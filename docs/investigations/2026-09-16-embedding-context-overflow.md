# OpenBrain embedding context overflow — live investigation, 2026-09-16

The reported error is reproducible in the deployed `embed()` function. There are
two interacting problems: OpenBrain clips text by UTF-16 code units rather than
model tokens, and Ollama's default token truncation fails for some inputs. A
larger `num_ctx` setting does not enlarge this deployment's effective context.

This is an investigation and reproducer, not a deployed correction. No service
configuration, model, database record or schema was changed during the probes.
The diagnostic requests do consume inference CPU and appear in Ollama logs.

The intended write contract rejects writes when embedding fails. A chunked index
should preserve one canonical thought or session record containing the full
text; all required embeddings must succeed before the record and its index
commit.

## Verified deployment

Observed on the tested deployment:

| Item                                    | Observed value                                                            |
| --------------------------------------- | ------------------------------------------------------------------------- |
| App checkout HEAD                       | `0093a9fd8ce35c51b08b1ee238bad88e218c7b3e`                                |
| Ollama version and configured image tag | `0.24.0`, `ollama/ollama:0.24.0`                                          |
| App embedding settings                  | `EMBED_MODEL=nomic-embed-text`, `EMBED_DIM=768`, `FETCH_TIMEOUT_MS=15000` |
| Resolved model                          | `nomic-embed-text:latest`, `nomic-bert`, 137M, F16, CPU                   |
| Model manifest digest                   | `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`        |
| Model weight blob digest                | `970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6`        |
| Tokenizer metadata                      | `tokenizer.ggml.model=bert`, BOS/CLS `101`, EOS/SEP `102`                 |
| Model metadata context                  | `nomic-bert.context_length=2048`                                          |
| Modelfile parameter                     | `num_ctx 8192`                                                            |
| Actual resident model context           | **2048**, from `/api/ps` and `ollama ps`                                  |
| Runner                                  | `ollama runner --ollama-engine`                                           |

The running app's `embeddings.ts`, `session_toml.ts`, `services.ts`,
`schemas.ts`, `request_body_limit.ts` and `mcp_result.ts` were SHA-256 compared
with the app checkout and the investigation checkout at
`eecc7b04d221022992b2fba679bc4980563717fd`. All six matched in all three
locations. Checkout HEAD alone is not proof of a running image's source; this
comparison verifies the files relevant here.

Ollama logs repeatedly report that requested `num_ctx=8192` exceeds
`n_ctx_train=2048`. The logs also contain embedding errors preceding the probes.

## Measurements

[Raw results](2026-09-16-embedding-context-probes.jsonl) come from
[the standalone probe](../../scripts/probe-embedding-context.ts). Requests are
serial, use synthetic text only, and call Ollama directly from the app
container. Counts below are UTF-16 code units, not Unicode code points or token
estimates. Token counts are Ollama's returned `prompt_eval_count`; failed
requests provide no measured token count.

| Synthetic input                                              | UTF-16 units | Policy                             | Result                                     |
| ------------------------------------------------------------ | -----------: | ---------------------------------- | ------------------------------------------ |
| `x` + space, repeated 2045 times                             |         4090 | `truncate:false`                   | 200, 2047 tokens                           |
| `x` + space, repeated 2046 times                             |         4092 | `truncate:false`                   | 200, 2048 tokens                           |
| `x` + space, repeated 2047 times                             |         4094 | `truncate:false`                   | 400, context overflow                      |
| `x` + space, repeated 2100 times                             |         4200 | default / explicit `truncate:true` | Both 200, 2048 tokens; input was shortened |
| `x` + space, repeated 2100 times                             |         4200 | `truncate:false`, `num_ctx:8192`   | 400, context overflow                      |
| Repeated ordinary English sentence                           |         8000 | default                            | 200, 1510 tokens                           |
| Repeated paths and UUIDs                                     |         8000 | default                            | 200, 2048 tokens                           |
| `数` repeated 2045 / 2046 times                              |  2045 / 2046 | `truncate:false`                   | 200, 2047 / 2048 tokens                    |
| `数` repeated 2047 times                                     |         2047 | default                            | **400, context overflow**                  |
| `数据库嵌入` repeated 600 times                              |         3000 | default / explicit `truncate:true` | **Both 400, context overflow**             |
| `e` + combining acute + space, repeated 2000 times           |         6000 | default                            | 200, 2002 tokens                           |
| Emoji + space, repeated 2000 times                           |         6000 | default                            | 200, 2002 tokens                           |
| Repeated code containing `réembedding`                       |         8000 | default                            | **400, context overflow**                  |
| Repeated UUID                                                |         8000 | default                            | 200, 2048 tokens                           |
| Four session-like fields, NUL-joined, with paths and Unicode |         8000 | default                            | **400, context overflow**                  |

The strict repeat probes establish a 2048-token accepted boundary and two tokens
of overhead for those inputs. They do not establish a universal character budget
or prove that CJK/emoji are represented meaningfully by this vocabulary.

Separately, importing `/app/embeddings.ts` inside the running app container and
calling its exported `embed()` produced:

- Short synthetic English text: success, 768 dimensions.
- The 3000-unit Chinese sample: the exact reported `Ollama embed failed: 400`
  error.
- The 8800-unit code sample, clipped to 8000 by the deployed function: the same
  error.

No OpenBrain capture API or database mutation was used for these reproductions.

## Why `truncate:true` and `num_ctx:8192` do not fix it

[Ollama documents](https://docs.ollama.com/api/embed) truncation as enabled by
default. OpenBrain omits that option, so adding `true` repeats existing
behavior. The live tests show that truncation works for some inputs and fails
for others.

In the
[0.24.0 embedding handler](https://github.com/ollama/ollama/blob/v0.24.0/server/routes.go#L713),
an overlong input is tokenized, clipped, decoded back to text, then embedded one
more time. The decoded text is not checked in a loop before that final attempt.
Tokenization of decoded text can expand again. The observed content-dependent
failure is consistent with that mechanism and
[upstream issue #14186](https://github.com/ollama/ollama/issues/14186).
[PR #14230](https://github.com/ollama/ollama/pull/14230) proposes a verification
loop and was still open when checked. We did not instrument the deployed
tokenizer's intermediate arrays, so the exact expansion for each probe remains
an inference rather than a measured token trace.

The
[0.24.0 model loader](https://github.com/ollama/ollama/blob/v0.24.0/llm/server.go#L156)
clamps context to the GGUF training-context metadata. The live metadata,
resident context, warning logs and explicit 8192 request agree. Setting a larger
number alone cannot fix this deployment. The model's advertised long-context
capability does not override the loaded artifact and runtime behavior.

## OpenBrain limits relevant to this failure

Source references below describe the verified app source unless otherwise
marked. This inventory covers the investigated paths; it is not an exhaustive
audit of transport, storage and client limits.

| Operation/layer                                   | Bound and unit                                                              | Scope and behavior                                                                                                  | Source                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| MCP / REST authenticated request body             | 1,048,576 bytes                                                             | Whole serialized body, including JSON escaping; rejected before JSON parsing                                        | `server/request_body_limit.ts`, `server/index.ts`, `server/api.ts` |
| Funnel Caddy request body                         | `max_size 1MB` in repository config                                         | Public Funnel route only; active adapted Caddy byte value was not measured in this investigation                    | `deploy/compose-tailnet/Caddyfile`                                 |
| Thought capture / content update                  | 100,000 UTF-8 bytes                                                         | Per `content`; validation error before embedding                                                                    | `server/schemas.ts`                                                |
| Session capture / refresh                         | 100,000 UTF-8 bytes                                                         | Entire `toml_text`, including all fields, artifacts and TOML syntax                                                 | `server/schemas.ts`                                                |
| Thought and session search                        | 8192 UTF-8 bytes                                                            | Per `query`; validation error before embedding                                                                      | `server/schemas.ts`                                                |
| Shared embedding pre-processing                   | 8000 UTF-16 code units                                                      | Prefix only, silently clipped; applies to thoughts, content updates, and searches as well as sessions               | `server/embeddings.ts`                                             |
| Session embedding source                          | 8000 UTF-16 code units                                                      | Shared prefix of four NUL-joined fields, silently clipped                                                           | `server/session_toml.ts:embedSource`                               |
| Ollama model input                                | 2048 model tokens, including special-token overhead                         | Default automatic truncation may succeed or return 400; `truncate:false` rejects overflow                           | Live tests and `/api/ps`                                           |
| Embedding request deadline                        | 15,000 ms live                                                              | Includes response-body consumption; an additional latency constraint for any proposed chunking design               | `server/config.ts`, `server/embeddings.ts`                         |
| Thought provenance labels                         | 1024 UTF-16 code units                                                      | Each trimmed author / agent / repo / branch label                                                                   | `server/schemas.ts`                                                |
| Workspace / project IDs                           | 128 UTF-16 code units                                                       | Each trimmed scope identifier                                                                                       | `server/scope_contract.ts`                                         |
| Other session strings / artifact strings / arrays | No additional general per-field length or item-count cap in the TOML parser | Still bounded by the aggregate 100,000-byte TOML document; scope IDs have their own bound                           | `server/session_toml.ts`                                           |
| Session database prose / artifact columns         | `TEXT`; no application length CHECK in the schema inspected                 | Successful captures retain complete fields; database physical limits were not probed                                | `db/04-sessions.sql`                                               |
| MCP tool result                                   | 120,000 UTF-8 bytes                                                         | Serialized `CallToolResult`, excluding outer JSON-RPC framing; explicit omission metadata and recovery instructions | `server/mcp_result.ts`                                             |
| Thought search / list                             | 100 rows maximum, 10 default                                                | Output may be reduced further by MCP result budget                                                                  | `server/schemas.ts`                                                |
| Session search                                    | 50 rows maximum, 5 default                                                  | Output may be reduced further by MCP result budget                                                                  | `server/schemas.ts`                                                |
| Session list                                      | 200 rows maximum, 50 default                                                | Output may be reduced further by MCP result budget                                                                  | `server/schemas.ts`                                                |
| REST response                                     | No equivalent MCP serialization budget in the app route examined            | External client/proxy constraints not measured; REST is the documented recovery route for omitted MCP fields        | `server/api.ts`, `server/mcp_result.ts`                            |

There is no generally safe 4900-, 6000-, or 8000-character authoring budget
established by these results. Content affects tokenization and truncation.

## Search coverage, hashing and write semantics

Session embedding input is exactly:

```ts
[title, goal, summary, resume_context]
  .map((value) => value ?? "")
  .join("\u0000")
  .slice(0, 8000);
```

OpenBrain adds no search-document/query prefix. The four fields share the budget
in that order, with three NUL delimiters. Artifacts, next actions, blockers,
tags, repository and branch fields are not part of this embedding input.

`computeContentHash()` SHA-256 hashes the UTF-8 encoding of that same prefix. An
edit entirely after the 8000-unit boundary does not trigger re-embedding.
Successful Ollama-side truncation can narrow coverage further, without any
coverage signal returned by `session_capture`. The hash represents the text
OpenBrain submitted, not necessarily every token the model finally consumed.
Neither model identity nor embedding-strategy version is included in this hash.

For sessions, `services.ts:captureSessionFromToml` waits for embedding before
calling `upsertSession`. A known embedding error therefore prevents the session
row and artifacts from being replaced. Thought capture likewise awaits embedding
before persistence. This preserves the all-or-nothing write contract. This
investigation did not test rollback using writes against the live database.

The embedding exception becomes `UpstreamError`; REST reports an upstream error
(502), while MCP exposes a tool error. The raw message omits the contributing
fields, their sizes, token budget and write outcome. A confirmed tool rejection
differs from an unknown transport timeout; reconcile the latter with lookup
before retrying.

## Recommended correction and remaining work

Keep one canonical database record with the full original content and preserve
atomic writes. Chunk vectors are index data belonging to that record, not
independent user-visible thoughts or sessions. Make embedding input preparation
an explicit, versioned contract shared by thought and session writes and search
queries:

1. Embed supported chunks with `truncate:false`; verify fit using the actual
   tokenizer or bounded splitting on the specific context-overflow rejection.
   Preserve Unicode boundaries and never drop a chunk silently. Do not retry
   unrelated 400s, transport failures or timeouts as if they were length errors.
2. Decide how document chunks participate in retrieval. Per-chunk vectors
   preserve matching passages but require schema/query work. Pooling chunk
   vectors avoids that schema change but may dilute a distinctive passage;
   evaluate recall before choosing it. Keep query handling consistent with the
   chosen strategy.
3. Replace the silent 8000-unit prefix loss with explicit supported-record and
   chunk limits, coverage reporting, and hashing of the full chosen source. A
   changed strategy/model needs a deliberate re-embedding plan for existing
   records, not just new writes.
4. Return actionable overflow/coverage information in correct units, naming
   contributing fields and whether the write committed. Retain complete source
   records and exclude private content from diagnostic messages.
5. Cover creation and refresh failure preserving existing rows/artifacts,
   thought updates, both search paths, Unicode boundaries, hash alignment,
   request deadlines, and REST/MCP error reporting. Publish the complete limits
   contract and update session-tracker/tool guidance as part of that correction.

Simply lowering the character cap is not a proven token bound. A different model
or runtime can be evaluated, but needs artifact-specific boundary tests and a
corpus migration/recall plan. No new model or Ollama version was installed here.

Historical successful session records do not recover previously rejected
payloads. The original rejected payloads were not obtained in this
investigation. Synthetic and deployed-function reproductions establish the
present failure, without claiming byte-for-byte replay of historical incidents.

## Re-running the probe

Run from this checkout in an environment that can reach the intended Ollama
endpoint. No database credentials are needed. For a local Ollama service:

```sh
OLLAMA_URL=http://127.0.0.1:11434 EMBED_MODEL=nomic-embed-text \
  deno run --allow-env=OLLAMA_URL,EMBED_MODEL --allow-net=127.0.0.1:11434 \
  scripts/probe-embedding-context.ts
```

Adjust the URL and network permission to the endpoint being tested. To select a
short check, append `tiny cjk-2047-default code-8000` after the script path.
HTTP error responses are recorded observations, not a nonzero script exit;
network/parse/metadata failures abort. No input text or vectors are printed. The
script was formatted/type-checked with Deno and executed against the live
configured model; the adjacent JSONL preserves that run.
