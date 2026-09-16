# OpenBrain embedding context overflow — live investigation, 2026-09-16

The reported error is reproducible in the deployed `embed()` function. OpenBrain
clips text by UTF-16 code units rather than model tokens; Ollama 0.24.0's
token-to-text truncation retry can overflow again when the retained prefix
contains unknown tokens. The same runtime also mishandles uppercase text: two
unrelated short uppercase phrases produced identical embeddings in live probes.
Chunking alone does not correct that defect. A larger `num_ctx` setting does not
enlarge this deployment's effective context.

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
or prove that CJK/emoji are represented meaningfully by this vocabulary. The
combining-mark and emoji cases consume only 2002 tokens; neither exercises
truncation. In the follow-up run they also produce identical vector hashes,
which illustrates why HTTP 200 does not establish meaningful representation.

Separately, importing `/app/embeddings.ts` inside the running app container and
calling its exported `embed()` produced:

- Short synthetic English text: success, 768 dimensions.
- The 3000-unit Chinese sample: the exact reported `Ollama embed failed: 400`
  error.
- The 8800-unit code sample, clipped to 8000 by the deployed function: the same
  error.

No OpenBrain capture API or database mutation was used for these reproductions.

### Follow-up: unknown-token placement and casing

[Follow-up results](2026-09-16-embedding-context-followup.jsonl) contain 16
requests: eight repeated controls and eight new cases on the same runtime and
model. Eleven succeeded and five reproduced the overflow. Successful responses
include `embedding_sha256`, SHA-256 of the UTF-8 JSON serialization of the
returned numeric array; raw vectors are not published. Equal hashes here compare
exact numeric arrays, not retrieval quality or a cross-runtime similarity
threshold. The original 20-result artifact remains unchanged.

| New synthetic input                                 | Default-policy result                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `x` + space, repeated 2047 times                    | 200, 2048 tokens                                                                |
| 2100 repetitions of `x` + space, then emoji         | 200, 2048 tokens; same hash as the strict 2046-repeat control                   |
| Emoji + space, then 2100 repetitions of `x` + space | 400, context overflow                                                           |
| `X` + space, then 2099 repetitions of `x` + space   | 400, context overflow                                                           |
| `REPLACE SUMP PUMP` / `CREATE A SPREADSHEET`        | Both 200, five tokens each, **identical vectors**                               |
| `replace sump pump` / `create a spreadsheet`        | Both 200, six / seven tokens; distinct from each other and the uppercase vector |

Reading `/api/show` with `verbose:true` also verified the deployed vocabulary:
30,522 entries; `[UNK]=100`, `[CLS]=101`, `[SEP]=102`, `▁[=1031`, `▁]=1033`,
`▁x=1060`, and `▁we=2057`. The `▁` prefix marks a word boundary. There are no
ASCII-uppercase vocabulary entries outside bracketed special tokens; `▁X`,
`▁We`, `▁数`, `▁😀`, and `▁é` are absent. These are selected vocabulary lookups,
not captured intermediate token arrays.

## Why `truncate:true` and `num_ctx:8192` do not fix it

[Ollama documents](https://docs.ollama.com/api/embed) truncation as enabled by
default. OpenBrain omits that option, so adding `true` repeats existing
behavior. The live tests show that truncation works for some inputs and fails
for others.

In the
[0.24.0 embedding handler](https://github.com/ollama/ollama/blob/v0.24.0/server/routes.go#L762-L802),
an overlong input is tokenized without special tokens, clipped to 2046 content
tokens after reserving BOS/EOS, decoded back to text, then embedded once more.
The decoded text is not checked in a loop before that final attempt.

The tagged
[WordPiece decoder](https://github.com/ollama/ollama/blob/v0.24.0/tokenizer/wordpiece.go#L35-L55)
writes token 100 as literal `[UNK]`. Its
[encoder](https://github.com/ollama/ollama/blob/v0.24.0/tokenizer/wordpiece.go#L57-L150)
splits punctuation before vocabulary lookup: `[UNK]` becomes `[`, unknown `UNK`,
and `]`, expanding one token to three. For a full retained prefix of otherwise
stable `x` tokens with `u` unknowns, the retry therefore needs `2048 + 2u`
tokens including BOS/EOS. One retained unknown predicts 2050; 2046 unknowns, as
in the repeated `数` case, predict 6140. These counts are source-derived, **not
measured `prompt_eval_count` values** from failed requests. No intermediate
arrays were instrumented in the deployed runner.

The new placement probes confirm the predicted success/failure distinction: an
unknown discarded beyond the cutoff is harmless to that retry; one retained at
the beginning causes it to overflow. This is a concrete mechanism for the tested
failures, not an exhaustive characterization of every possible decode/re-encode
transformation. It agrees with
[upstream issue #14186](https://github.com/ollama/ollama/issues/14186).
[PR #14230](https://github.com/ollama/ollama/pull/14230) proposes a verification
loop and was still open when checked on 2026-09-16.

The
[0.24.0 model loader](https://github.com/ollama/ollama/blob/v0.24.0/llm/server.go#L166-L171)
clamps context to the GGUF training-context metadata. The live metadata,
resident context, warning logs and explicit 8192 request agree. Setting a larger
number alone cannot fix this deployment. The model's advertised long-context
capability does not override the loaded artifact and runtime behavior.

## Uppercase inputs also affect successful embeddings

The
[0.24.0 Nomic BERT constructor](https://github.com/ollama/ollama/blob/v0.24.0/model/models/nomicbert/model.go#L200-L221)
passes `lowercase=false` to WordPiece despite the uncased vocabulary. With this
encoder, tested capitalized ASCII words such as `We` and `X` cannot be matched;
an unmatched word becomes `[UNK]`. This also explains the uppercase overflow
discriminator and the three-word uppercase collision above. The source-selected
tokenizer matches the observed `--ollama-engine` runner.

This affects short successful requests as well as long documents. The live
collision proves loss of distinction for those phrases; it does not quantify
corpus-wide recall or prove that every stored vector is unusable. The original
20 probes did not distinguish correct from incorrect case normalization.

[Upstream issue #13942](https://github.com/ollama/ollama/issues/13942) documents
the same uppercase collision. The direct lowercase-change proposal,
[PR #13943](https://github.com/ollama/ollama/pull/13943), was closed
**unmerged**. A later
[upstream version comparison](https://github.com/ollama/ollama/issues/13942#issuecomment-4617769764)
reports matching lower/uppercase results on 0.30.0 and 0.30.3, with numerical
changes even for lowercase input relative to earlier runtimes. That is upstream
evidence, not a replacement-runtime test performed here. Validate a selected
runtime/model combination before relying on it; do not infer a deployed fix from
a closed issue or unmerged patch.

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
Neither model identity, runtime/tokenizer identity nor embedding-strategy
version is included in this hash. Fixing the runtime can therefore change
embeddings without changing the session hash, even with identical model bytes.

Thoughts have a separate deduplication fingerprint in
`server/queries.ts:FINGERPRINT_SQL`: SHA-256 over the UTF-8 encoding of the
**full body**, after whitespace collapsing, trimming and lowercasing. It is not
the session prefix hash or an embedding cache key. A changed thought body,
including an edit entirely after the 8000-unit boundary, still invokes `embed()`
through `services.ts:updateThoughtInScope`; the embedder continues to see only
the unchanged prefix in that case. Exact unchanged-body updates return before
embedding. A future index-version/hash migration must preserve these distinct
deduplication and embedding-refresh responsibilities.

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

1. Validate a corrected embedding runtime/model **before or together with**
   chunking. Repeat boundary, unknown-token, casing and representative retrieval
   checks; choose the tokenizer, normalization and task-prefix contract
   together. The
   [Nomic model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5#usage)
   specifies `search_document:` and `search_query:` prefixes, which OpenBrain
   currently omits. Include prefixes and special tokens in each chunk's budget.
   Chunking or lowercasing alone is not a validated repair of this runtime.
2. Embed supported chunks with `truncate:false`; verify fit using the actual
   tokenizer or bounded splitting on the specific context-overflow rejection.
   Preserve Unicode boundaries and never drop a chunk silently. Do not retry
   unrelated 400s, transport failures or timeouts as if they were length errors.
3. Decide how document chunks participate in retrieval. Per-chunk vectors
   preserve matching passages but require schema/query work. Pooling chunk
   vectors avoids that schema change but may dilute a distinctive passage;
   evaluate recall before choosing it. Keep query handling consistent with the
   chosen strategy.
4. Replace the silent 8000-unit prefix loss with explicit supported-record and
   chunk limits, coverage reporting, and hashing of the full chosen source. A
   changed strategy/model/runtime/tokenizer needs a versioned index identity and
   a **full-corpus re-embedding plan**, including unchanged records. Preserve
   thought deduplication separately. Do not build the new chunk index using the
   defective runtime and then rebuild it again after an upgrade. Coordinate
   corpus rebuild and query cutover so incompatible vector spaces are not mixed.
5. Return actionable overflow/coverage information in correct units, naming
   contributing fields and whether the write committed. Retain complete source
   records and exclude private content from diagnostic messages.
6. Cover creation and refresh failure preserving existing rows/artifacts,
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
script now contains 28 cases. The original artifact records the initial 20; the
follow-up artifact records this selected run:

```sh
OLLAMA_URL=http://127.0.0.1:11434 EMBED_MODEL=nomic-embed-text \
  deno run --allow-env=OLLAMA_URL,EMBED_MODEL --allow-net=127.0.0.1:11434 \
  scripts/probe-embedding-context.ts \
  tiny ascii-2046-strict ascii-2100-default cjk-2047-default \
  combining-6000 nonbmp-6000 code-8000 session-8000 \
  ascii-2047-default unknown-after-cut unknown-before-cut uppercase-before-cut \
  uppercase-pump uppercase-spreadsheet lowercase-pump lowercase-spreadsheet
```

To reproduce the exported-function check, run the following from the deployed
repository using its Compose file. The existing container supplies the app's
required environment; importing configuration reads those settings but does not
print credentials or open a database connection. The three calls only perform
synthetic embedding inference. Adjust the Compose file for the stack being
tested.

```sh
docker compose --env-file deploy/qubes/app-qube/.env \
  -f deploy/qubes/app-qube/docker-compose.yml exec -T mcp \
  deno run --cached-only --allow-env --allow-net --allow-read /dev/stdin <<'JS'
const { embed } = await import("file:///app/embeddings.ts");
const cases = [
  ["short", "hello"],
  ["cjk-3000", "数据库嵌入".repeat(600)],
  [
    "code-8800",
    "const foo_bar = await svc.session_capture({toml_text: payload}); // réembedding\n"
      .repeat(120).slice(0, 8800),
  ],
];
for (const [name, input] of cases) {
  try {
    const vector = await embed(input);
    console.log(JSON.stringify({ name, utf16_units: input.length, dimensions: vector.length }));
  } catch (error) {
    console.log(JSON.stringify({ name, utf16_units: input.length, error: String(error) }));
  }
}
JS
```

The function check was repeated during review: `short` returned 768 dimensions;
`cjk-3000` and `code-8800` both returned the reported Ollama context error. The
probe is a point-in-time diagnostic, not a CI inference test. Repository
formatting/lint CI covers it, but the existing type-check job does not target
this script. Validation here used Deno 2.9.4 from the repository root:

```sh
deno fmt --check
deno lint
deno check scripts/probe-embedding-context.ts
```
