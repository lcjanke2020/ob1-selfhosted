---
name: session-tracker
description: "Use when starting, resuming, or wrapping up an agent/coding work session — and on cues like \"where did I leave off\", \"resume the X work\", \"what's awaiting review\", \"save this session\", \"what was I doing on <branch>\". Captures and restores structured session state via Open Brain's session_* MCP tools. State lives in Open Brain's canonical `sessions` store; TOML front matter is the interchange format."
---

# Session Tracker

For capturing, resuming, and lifecycle-managing **agent work sessions** in Open
Brain via its `session_*` MCP tools. A _session_ is the structured work-log of
one coding/agent task — repo, branch, goal, what's left, what's blocking — so
any agent on any machine can pick the thread back up later.

This skill is the **usage contract**; the MCP tools (registered by
`server/mcp-server.ts` in this repo, schema in `db/04-sessions.sql`) are the
mechanism. The schema and behaviour below were verified against live round-trips
of the as-built tools, not a design sketch — author to _this_.

## When to use

- A work session is **starting**, being **resumed**, or being **wrapped up**.
- Resume cues: "where did I leave off", "resume the X work", "what was I doing
  on `<branch>`", "what's awaiting review / still blocked".
- Save cues: "save this session", "snapshot where we are before I stop".

**Sessions vs `thoughts`.** Sessions are a _structured work-log of a
coding/agent task_ (this skill). `thoughts` capture is _free-form memory_
(notes, facts, ideas). Don't put session data into `thoughts`, and don't log
free-form memories as sessions.

**Thought provenance stays separate.** This skill calls `session_*` tools and
does not populate `capture_thought` provenance from session fields. When an
agent independently captures a reusable thought during a session, that separate
call should provide the known caller-asserted `author` / `agent` / `repo` /
`branch` values and omit unknowns; the server keeps them distinct from verified
transport identity. See
[`docs/thought-provenance.md`](../../docs/thought-provenance.md).

## Mental model

- The **OB1 Postgres `sessions` store is canonical** — there is no second
  on-disk artifact. Durability is OB1's `pg_dump` backup path, not a separate
  replication system. Mutate sessions only through the `session_*` tools, never
  raw SQL.
- **TOML front matter is the input format** to `session_capture`: a flat TOML
  document wrapped in `+++` delimiter lines (a `+++` before and after the TOML).
  Assemble it from the live working context and capture it — you do **not** need
  to keep it on disk.
- **`raw_toml` is historical input, not canonical state.** `session_lookup`
  returns the verbatim document supplied to the most recent `session_capture`,
  but it may differ from current structured fields (for example, after
  `session_update_status`). Treat the structured fields as authoritative and
  never use `raw_toml` as a recapture template; assemble recapture TOML fresh
  from `session_lookup`'s current structured record plus live context.
- **Where the `id` lives between sessions.** With no file to hold it, the
  returned integer `id` still needs a home so a later capture _updates_ the same
  row instead of minting a duplicate. The primary path is re-discovery:
  `session_lookup(branch="…")` or `session_search(query=…)`, then read the `id`
  off the record and write it into the TOML you re-capture. Optionally stash the
  `id` in agent project memory for the active work-thread. Either way, **always
  recover the `id` before re-capturing** — see Capturing.

## Front-matter schema (authoring reference)

The schema is **flat** — a single TOML document between `+++` delimiter lines.
Group fields with `#` comments for readability; they round-trip.

**Fields you author** (all optional unless noted):

| Group            | Keys                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity         | `agent`, `agent_version`, `harness`                                                                                                                                       |
| Where            | `machine`, `working_dir`, `repo_url`, `branch`, `head`, `worktree`                                                                                                        |
| When             | `started_at`, `last_update`, `ended_at`, `session_date`                                                                                                                   |
| What             | `title`, `goal`, `status` (enum), `tags`, `linked_issues`, `related_sessions`, `next_actions`, `blockers`                                                                 |
| Prose            | `summary`, `resume_context` (TOML `"""…"""` multiline)                                                                                                                    |
| Memory scope     | `workspace_id`, `project_id`, `visibility` (`personal \| project \| workspace`)                                                                                           |
| Artifacts        | `[[artifacts]]` array-of-tables — `kind` + `title` required, `detail` optional (see below)                                                                                |
| Upsert key       | `id` (integer) — **only ever the value the server returned** (see Capturing)                                                                                              |
| Resumable handle | `session_id` — optional, free-form, nullable; the _harness conversation id_ for re-opening the chat transcript later (see _The resumable handle_ below). **NOT** the key. |

Every ordinary string-valued scalar must use TOML string syntax, including
identity, location, prose, status, scope, and resumable-handle fields. The
parser does not coerce numbers or booleans into strings. Session time fields
also accept TOML date literals, timezone-qualified TOML datetime literals, or
quoted timezone-qualified ISO-8601 strings.

`tags`, `linked_issues`, `related_sessions`, `next_actions`, and `blockers` are
**arrays of quoted strings** (`key = ["..."]`) — write the bare key, never
`key[]`, and never supply a scalar or a non-string element. `related_sessions`
is free-form in meaning (point at other sessions by their integer `id` encoded
as strings, such as `["42", "57"]`): the server stores those strings verbatim
and never validates or joins on them; it is not a foreign-key reference.

- **`status` enum:** `active | awaiting_review | blocked | done | abandoned`.
- **Timestamps** are ISO-8601. Date-only (`"2026-06-08"`) is accepted and
  expanded to midnight UTC; full timestamps must carry `Z` or an explicit
  numeric offset. Bare TOML datetime literals normalize to UTC during parsing,
  and persisted structured timestamp fields represent instants rather than
  preserving the authored spelling; `raw_toml` preserves that original text. A
  timestamp supplied for `session_date` stores its UTC calendar date.
- **Embedded-for-search content** is `title` / `goal` / `summary` /
  `resume_context`; the server re-embeds only when that content changes
  (`content_hash`).

**Server-stamped — never author these:** `owner_subject`, `source`,
`source_node`, `content_hash`, `created_at`, `updated_at`. The server sets
identity/provenance from the authenticated transport — don't write it by hand.
Unknown top-level TOML fields are rejected, not ignored; a misspelled workspace
must never become omitted scope. The retired `ingested_path` and
`needs_file_sync` fields are also rejected. Never reuse returned `raw_toml`;
rebuild a refresh from current structured fields and live context.

**Memory scope.** Omitted `workspace_id` selects exactly the server's configured
default workspace, never all workspaces. `project_id` names a registered project
inside that workspace. On capture, omitted `visibility` chooses `project` when a
project is present and otherwise the workspace default. On
lookup/search/list/status updates, pass a nested MCP
`scope = {workspace_id, project_id?, visibility?}` argument; omitted visibility
reads the allowed audience union inside that one workspace. Always reuse the
stored workspace/project context when refreshing or mutating an existing
session. See [`docs/spaces.md`](../../docs/spaces.md).

**`[[artifacts]]`** attach references — a PR, a note, a file, a branch — to the
session. Each is a TOML table in an `[[artifacts]]` array: `kind` and `title`
are **required**, `detail` is optional; the server assigns `position` from array
order (don't author it). Unknown fields, a single `[artifacts]` table, or a
singular `[[artifact]]` block are **rejected with an error** — so once
`session_capture` returns success, the artifacts did land.

### The resumable handle (`session_id`)

`session_id` is a **best-effort harness conversation id** — the handle that lets
a human re-open the _actual chat transcript_ later. It is **not** the key (the
integer `id` is), it is free-form, and it is **nullable**: a session with no
resumable transcript should carry no handle rather than a dead value.

**Where it comes from is harness-specific.** The rule is the same everywhere —
**only stamp an id you've confirmed is resumable, and let the transcript file be
the authority** — but the id's source and the transcript's location differ per
harness. Find your harness below; if it isn't listed, work out its own id +
transcript pair rather than assuming another harness's env var applies.

> ⚠️ **Absence of one harness's signal is not evidence of "no transcript."** An
> agent that checks only `CLAUDE_CODE_SESSION_ID`, finds it unset, and concludes
> the session is unresumable will silently drop a perfectly good handle when
> running under a different harness. Check the harness you are actually in.

**Claude Code**

- **Id:** exposed in the environment as `CLAUDE_CODE_SESSION_ID`. This is
  harness-specific and may change in future Claude Code versions — treat it as
  advisory, not a contract. If it's unset, don't invent one; leave `session_id`
  out.
- **Transcript:** check by **glob** — `~/.claude/projects/*/<session_id>.jsonl`.
  The id is unique, so this finds the transcript no matter how Claude Code
  encodes the project-dir name (it folds more than just `/` — `_`, `.`, etc. all
  become `-`, so don't try to reconstruct the path by hand). Treat
  `CLAUDE_CODE_CHILD_SESSION=1` as a _caution_ that the id may be a sub-session
  rather than the top-level conversation (the two signals can disagree — a child
  env can still have a real transcript): let the glob decide, and when in doubt
  leave it out.

**GitHub Copilot CLI**

- **Id:** there is **no `CLAUDE_CODE_SESSION_ID`-style env var**. The
  conversation id is the **session-state directory name**, surfaced to the agent
  in its session context as the session folder —
  `~/.copilot/session-state/<session_id>/`. It is a UUID.
- **Transcript:** `~/.copilot/session-state/<session_id>/events.jsonl`. Confirm
  it exists **and holds real turns** before stamping — a session dir can exist
  with a near-empty log. A quick sanity check is that the file contains
  `assistant.message` events, not just `hook.*` / lifecycle noise.

If no file matches for your harness, **don't stamp** — an honest "no transcript"
beats an id that resolves to nothing.

**Regardless of harness:**

- **Stamp `machine`, `working_dir`, and `harness` alongside it.** Transcripts
  are _machine-local_, so the record must say **which host** (`machine`, e.g.
  the box's hostname) and **which directory** (`working_dir`) the work happened
  in — and **which harness** (`harness`), since that selects the resume command.
  For a listed harness, use the resume table's exact stored value:
  `harness = "Claude Code"` or `harness = "GitHub Copilot CLI"`. These are
  documentation conventions, not a schema-enforced enum; for an unlisted
  harness, use its stable product name consistently. See _Resuming the actual
  conversation from the CLI_ below for how the fields are used together.
- **Refresh caveat:** on a re-capture (with `id`), the server
  **COALESCE-preserves** `session_id` — omitting it **keeps** the stored handle,
  and **TOML capture has no way to reset it to SQL `NULL`**. To point at a
  different conversation, write the new value; to retire a dead one, set
  `session_id = ""` — note this stores an **empty string**, not `NULL`. Treat
  empty the same as unset everywhere: the resume glob can't match it, so it's
  functionally "no handle". Rarely needed anyway — the resume step re-globs for
  the transcript before trusting any handle, so a stale handle never yields a
  false resume.

### Minimal example (verified round-trip)

```toml
+++
title = "Investigate flaky billing integration test"
status = "active"
agent = "claude-opus-4-8 (Claude Code)"
started_at = "2026-06-08"
last_update = "2026-06-08"
repo_url = "https://github.com/acme/billing-service"
branch = "fix/flaky-invoice-test"
goal = "Find and fix the intermittent failure in test_invoice_rounding."
+++
```

### Sensitive personal example

The seeded `sensitive` workspace is personal-only. It requires a verified OAuth
subject or a local shared-key deployment configured with
`MCP_ACCESS_KEY_PRINCIPAL`; project/workspace visibility is rejected:

```toml
+++
title = "Private work log"
status = "active"
workspace_id = "sensitive"
visibility = "personal"
goal = "Keep particularly sensitive work in my personal audience."
+++
```

### Full example (verified round-trip)

```toml
+++
title = "Add Redis-backed rate limiting to the API gateway"
status = "awaiting_review"

# identity
agent = "claude-opus-4-8 (Claude Code)"
agent_version = "1.2.0"
harness = "Claude Code"

# where
machine = "workstation-01"
working_dir = "/home/dev/src/api-gateway"
repo_url = "https://github.com/acme/api-gateway"
branch = "feature/rate-limit"
head = "9f3a1c2b7d4e5f6071829304a5b6c7d8e9f00112"
worktree = "/home/dev/src/api-gateway"

# resumable handle — harness conversation id (machine-local transcript); omit if none
session_id = "9c8b7a6d-5e4f-3210-fedc-ba9876543210"

# when
started_at = "2026-06-07T14:30:00Z"
last_update = "2026-06-08T09:15:00Z"
ended_at = "2026-06-08T09:15:00Z"
session_date = "2026-06-08"

# what
goal = "Add per-client rate limiting at the gateway, backed by Redis, behind a feature flag."
tags = ["api-gateway", "rate-limiting", "redis"]
linked_issues = ["ACME-1487", "ACME-1490"]
# free-form, unvalidated — reference other sessions by their integer id
related_sessions = ["42", "57"]

summary = """
Implemented a sliding-window limiter in middleware/ratelimit.go, wired it into the
gateway chain behind the rate_limit_enabled flag, and added unit + integration tests.
Redis client is reused from the existing pool. PR #214 is open and green in CI.
"""

resume_context = """
The limiter is feature-flagged OFF by default; flip rate_limit_enabled in
config/gateway.yaml to exercise it. Integration test spins up a Redis container via
testcontainers. Open question for review: per-instance counters vs a shared Redis Lua
script for cross-instance accuracy — see next_actions.
"""

next_actions = [
  "Address review feedback on PR #214",
  "Decide per-instance counters vs shared Redis Lua script for cross-instance accuracy",
  "Document the new config keys in the gateway README",
]

blockers = [
  "Waiting on platform-team review for the Redis Lua-script question",
]

# artifacts — kind + title required, detail optional; the server assigns `position`
[[artifacts]]
kind = "pr"
title = "api-gateway#214"
detail = "Open PR implementing the sliding-window limiter."

[[artifacts]]
kind = "note"
title = "Benchmark: sliding-window vs token-bucket"
+++
```

## Capturing a session

1. Populate the front matter from the **live working context** — read
   `repo_url`, `branch`, `head` from the actual checkout (`git rev-parse`,
   `git branch --show-current`), `machine` / `working_dir` from the host, and
   the resumable `session_id` per _The resumable handle_ above — not from memory
   or a returned `raw_toml`. Stamp `harness` too whenever you stamp
   `session_id`: resume needs it to know which command reopens the transcript.

   A recapture (`id` present) is a full replacement of the authorable document
   and artifact set, not a patch. `title` remains required. Apart from
   `session_id` and `status`, which are preserved when omitted, omitted optional
   scalars become null, omitted arrays become empty, and omitting all
   `[[artifacts]]` blocks deletes stored artifacts. Re-send every field and
   artifact you intend to retain, taking stored values from `session_lookup`'s
   structured record and updating them from live context where applicable.
   Re-send the stored `workspace_id`, `project_id`, and `visibility` so the
   existing row is targeted through its actual audience. **Omit `status` unless
   you are deliberately changing lifecycle state.**
2. Assemble the TOML in memory (no on-disk file needed).
3. Call `session_capture(toml_text)`. It returns
   `{id, session_id, status, created,
   reembedded, workspace_id, project_id, visibility}`.
4. **First capture only:** the front matter has no `id`, so the server **mints
   one** and returns it (`created: true`). **Retain that `id` for this
   work-thread** — stash it in agent project memory, or plan to re-discover it
   via `session_lookup(branch="…")` / `session_search` — and **include it on
   every later capture.** The `id` makes the call _update_ the same record
   (`created: false`); re-embedding happens only if
   `title`/`goal`/`summary`/`resume_context` changed.

   > ⚠️ **Omitting `id` on a re-capture creates a duplicate session, not an
   > update.** The "never author `id`" rule means _never invent one_ — only ever
   > re-send the exact value the server handed you. (`session_id` is a separate,
   > optional resumable handle — not the upsert key; omitting it never
   > duplicates.)

   > ⚠️ **A record whose `id` you've lost** — you didn't stash it, or you're
   > picking the thread up on another machine — takes the insert path on a
   > straight re-capture and mints a _duplicate_, orphaning the existing DB row.
   > First recover the row's `id` (`session_lookup(branch="…")` or
   > `session_search`) and put it in the TOML's `id =` line; then capture.

5. Don't author provenance — the server stamps `source` / `source_node`.

## Resuming a session

- On a resume cue, locate the session first, supplying its workspace/project
  scope when it is not in the configured default:
  - by branch → `session_lookup(branch="<branch>", scope={…})` (on a branch tie,
    effective freshness wins: caller-supplied `last_update` when present,
    otherwise server-managed `updated_at`; remaining ties use `updated_at` then
    `id`);
  - by id → `session_lookup(id=<id>, scope={…})`;
  - fuzzy ("the session where I chased the flaky invoice test") →
    `session_search(query=…, scope={…})`, then `session_lookup` the best hit.
- `session_lookup` _fetches_ the stored record; it does not resume execution.
- Read current state from the structured fields. The returned `raw_toml` is only
  the verbatim input of the last capture, may lag later lifecycle updates, and
  is not a safe recapture template.
- **Read `resume_context` + `next_actions` + `blockers` before acting.**
  Reconstruct the working state from `repo_url` / `branch` / `head` rather than
  guessing.

### Resuming the actual conversation from the CLI

`session_lookup` restores the _work-log_, not the chat. To get the original
**transcript** back you run the harness's own resume command yourself — there is
no resume wrapper, and the two ids are **different namespaces**:

> ⚠️ **Resuming with the OB `id` does NOT work.** The OB integer `id` is the
> record key; a harness resume command wants the _harness conversation id_,
> which is stored in the record's `session_id` field. Passing the OB `id` (or a
> session's title) just errors — e.g. Claude Code reports "No conversation
> found".

Manual resume, search-driven:

1. **Find it:** `session_search(query=…)` to discover, then
   `session_lookup(id=…)` for the full record — or `session_lookup(id=…)` /
   `session_lookup(branch=…)` directly if you already know it.
2. **Read four fields** off the record: `machine` (which host), `working_dir`
   (which directory), `harness` (which resume command to use), `session_id` (the
   harness conversation id).
3. **On that `machine`**, resume with the matching harness:

   | Stored `harness` value | Resume with                                            |
   | ---------------------- | ------------------------------------------------------ |
   | `"Claude Code"`        | `claude --resume <session_id>` (shell command)         |
   | `"GitHub Copilot CLI"` | `/resume <session_id>` (slash command, inside the CLI) |

   Both resolve the transcript by id, so `cd` isn't required, but start from
   `working_dir` so the resumed work lands in the right project. Transcripts are
   machine-local, so this only works on the host that recorded it.

> This is why `harness` is worth stamping on every capture: without it, a
> resuming agent has to guess which command applies, and guessing wrong reads as
> "not resumable."

**No transcript available** — `session_id` is unset or empty, you're on a
different machine, or it was pruned/compacted — means **there is no
scrollback**. Start a fresh session in the relevant harness and rebuild from the
work-log (`resume_context` + `next_actions` + `blockers`), checking out
`repo_url` / `branch` / `head`. Say plainly that scrollback wasn't available and
the context was reconstructed from the session record.

## Searching & listing

- "What's awaiting review / blocked / active" →
  `session_list(status=…, scope={…})` (pure SQL filter; also filters by
  `repo_url`, `branch`, `agent`, `tag`, `linked_issue`, `since`, `until`).
- Fuzzy recall over title/goal/summary/resume_context →
  `session_search(query, …)` (semantic; optional `status` / `repo_url` / `tag`
  pre-filters and `threshold` minimum cosine similarity, default `0.5`).

## Lifecycle

- Quick transitions (e.g. mark `done` after a PR merges, or `blocked` when
  stuck) → `session_update_status(id, status, scope={…})`. Usable from any
  surface with no checkout; it writes the new structured `status` straight to
  the canonical store and returns `{id, status}`. It intentionally does not
  rewrite historical `raw_toml`. The write advances server-managed `updated_at`,
  so it also advances effective freshness when caller-supplied `last_update` is
  absent; a branch lookup may then select that session as the newest match.
  There is no file to reconcile.

## Honesty guardrails

These directly counter the "agent asserts success about its own state" failure
pattern.

- **Never claim a session was captured/updated unless the tool returned
  success.** Surface the actual return (`created`, `reembedded`, `status`).
- If a write fails or provenance can't be stamped, **say so plainly** — don't
  paper over it.
- **Don't fabricate** `id`s, statuses, or artifact refs — report only what the
  tools return (don't claim an artifact landed unless the capture succeeded).
- **Don't claim a conversation is resumable** unless `session_id` is set
  (non-empty) _and_ its transcript exists on this machine. Report what's
  actually known — host, dir, and `session_id` (or "no resumable transcript
  recorded") — and let the human resume.

## Anti-patterns

- Don't shove session data into `thoughts` (or free-form memories into
  sessions).
- Don't mutate sessions with raw SQL against the `sessions` schema — go through
  `session_capture` / `session_update_status`.
- Don't recapture a session's returned `raw_toml`; it is historical input and
  may differ from current structured state. Build a fresh document, include the
  server-issued `id`, re-send every field and artifact you intend to retain, and
  omit `status` unless intentionally changing it.
- Don't omit `id` when re-capturing (you'll mint a duplicate).
- Don't stamp `session_id` unchecked — confirm the transcript exists first
  (Claude Code: glob `~/.claude/projects/*/<session_id>.jsonl`; GitHub Copilot
  CLI: `~/.copilot/session-state/<session_id>/events.jsonl`); an id with no
  transcript won't resume. Leave it unset rather than guess.
- Don't treat one harness's missing env var as proof there's no transcript —
  `CLAUDE_CODE_SESSION_ID` is unset under GitHub Copilot CLI, which has its own
  id and transcript. Check the harness you're actually running in before
  recording "no resumable transcript".
- Don't author nested `[identity]` / `[where]` / `[state_for_resuming]` blocks —
  the schema is flat.
- Don't omit a non-default session's scope on lookup, refresh, or status update;
  omission selects the configured default workspace and therefore cannot target
  that row.
- Don't author server-stamped fields (`source`, `content_hash`, …).
- Don't pin embedding-model or dimension assumptions in session tooling —
  sessions follow whatever the Open Brain deployment uses.
