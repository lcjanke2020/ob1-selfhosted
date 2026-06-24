---
name: session-tracker
description: "Use when starting, resuming, or wrapping up an agent/coding work session — and on cues like \"where did I leave off\", \"resume the X work\", \"what's awaiting review\", \"save this session\", \"what was I doing on <branch>\". Captures and restores structured session state via Open Brain's session_* MCP tools. State lives in Open Brain's canonical `sessions` store; TOML front matter is the interchange format."
---

# Session Tracker

For capturing, resuming, and lifecycle-managing **agent work sessions** in Open Brain
via its `session_*` MCP tools. A *session* is the structured work-log of one
coding/agent task — repo, branch, goal, what's left, what's blocking — so any agent on
any machine can pick the thread back up later.

This skill is the **usage contract**; the MCP tools (registered by `server/mcp-server.ts`
in this repo, schema in `db/04-sessions.sql`) are the mechanism. The schema and
behaviour below were verified against live round-trips of the as-built tools, not a
design sketch — author to *this*.

## When to use

- A work session is **starting**, being **resumed**, or being **wrapped up**.
- Resume cues: "where did I leave off", "resume the X work", "what was I doing on
  `<branch>`", "what's awaiting review / still blocked".
- Save cues: "save this session", "snapshot where we are before I stop".

**Sessions vs `thoughts`.** Sessions are a *structured work-log of a coding/agent task*
(this skill). `thoughts` capture is *free-form memory* (notes, facts, ideas). Don't put
session data into `thoughts`, and don't log free-form memories as sessions.

## Mental model

- The **OB1 Postgres `sessions` store is canonical** — there is no second on-disk
  artifact. Durability is OB1's `pg_dump` backup path, not a separate replication
  system. Mutate sessions only through the `session_*` tools, never raw SQL.
- **TOML front matter is the input format** to `session_capture`: a flat TOML document
  wrapped in `+++` delimiter lines (a `+++` before and after the TOML). Assemble it from
  the live working context and capture it — you do **not** need to keep it on disk.
- **Where the `id` lives between sessions.** With no file to hold it, the returned integer
  `id` still needs a home so a later capture *updates* the same row instead of minting a
  duplicate. The primary path is re-discovery: `session_lookup(branch="…")` or
  `session_search(query=…)`, then read the `id` off the record and write it into the TOML
  you re-capture. Optionally stash the `id` in agent project memory for the active
  work-thread. Either way, **always recover the `id` before re-capturing** — see Capturing.

## Front-matter schema (authoring reference)

The schema is **flat** — a single TOML document between `+++` delimiter lines. Group
fields with `#` comments for readability; they round-trip.

**Fields you author** (all optional unless noted):

| Group | Keys |
|---|---|
| Identity | `agent`, `agent_version`, `harness` |
| Where | `machine`, `working_dir`, `repo_url`, `branch`, `head`, `worktree` |
| When | `started_at`, `last_update`, `ended_at`, `session_date` |
| What | `title`, `goal`, `status` (enum), `tags`, `linked_issues`, `related_sessions`, `next_actions`, `blockers` |
| Prose | `summary`, `resume_context` (TOML `"""…"""` multiline) |
| Artifacts | `[[artifacts]]` array-of-tables — `kind` + `title` required, `detail` optional (see below) |
| Upsert key | `id` (integer) — **only ever the value the server returned** (see Capturing) |
| Resumable handle | `session_id` — optional, free-form, nullable; the *harness conversation id* for re-opening the chat transcript later (see *The resumable handle* below). **NOT** the key. |

`tags`, `linked_issues`, `related_sessions`, `next_actions`, and `blockers` are
**array-valued** (`key = [ ... ]`) — write the bare key, never `key[]`.
`related_sessions` is a **free-form** list (point at other sessions by their
integer `id`) — the server stores it verbatim and never validates or joins on
it; it is not a foreign-key reference.

- **`status` enum:** `active | awaiting_review | blocked | done | abandoned`.
- **Timestamps** are ISO-8601. Date-only (`"2026-06-08"`) is accepted and expanded to
  midnight UTC; full timestamps round-trip as given.
- **Embedded-for-search content** is `title` / `goal` / `summary` / `resume_context`;
  the server re-embeds only when that content changes (`content_hash`).

**Server-stamped — never author these:** `source`, `source_node`, `content_hash`,
`created_at`, `updated_at`. The server sets `source` / `source_node` from the transport
(tailnet x-brain-key vs OAuth door) — don't write a `source` by hand.

**`[[artifacts]]`** attach references — a PR, a note, a file, a branch — to the session.
Each is a TOML table in an `[[artifacts]]` array: `kind` and `title` are **required**,
`detail` is optional; the server assigns `position` from array order (don't author it).
Unknown fields, or a singular `[[artifact]]`, are **rejected with an error** — so once
`session_capture` returns success, the artifacts did land.

### The resumable handle (`session_id`)

`session_id` is a **best-effort harness conversation id** — the handle that lets a human
re-open the *actual chat transcript* later. It is **not** the key (the integer `id` is),
it is free-form, and it is **nullable**: a session with no resumable transcript should
carry no handle rather than a dead value.

- **Where it comes from (Claude Code):** the running agent's conversation id is exposed in
  the environment as `CLAUDE_CODE_SESSION_ID`. This is harness-specific and may change in
  future Claude Code versions — treat it as advisory, not a contract. If it's unset, don't
  invent one; leave `session_id` out.
- **Only stamp an id you've confirmed is resumable — the transcript file is the authority.**
  Check for it by **glob**: `~/.claude/projects/*/<session_id>.jsonl`. The id is unique, so
  this finds the transcript no matter how Claude Code encodes the project-dir name (it folds
  more than just `/` — `_`, `.`, etc. all become `-`, so don't try to reconstruct the path
  by hand). If no file matches, **don't stamp** — an honest "no transcript" beats an id that
  resolves to nothing. Treat `CLAUDE_CODE_CHILD_SESSION=1` as a *caution* that the id may be
  a sub-session rather than the top-level conversation (the two signals can disagree — a
  child env can still have a real transcript): let the glob decide, and when in doubt leave
  it out.
- **Stamp `machine` and `working_dir` alongside it.** Transcripts are *machine-local*, so
  the record must say **which host** (`machine`, e.g. the box's hostname) and **which
  directory** (`working_dir`) the work happened in. See *Resuming the actual conversation
  from the CLI* below for how the fields are used together.
- **Refresh caveat:** on a re-capture (with `id`), the server **COALESCE-preserves**
  `session_id` — omitting it **keeps** the stored handle, and **TOML capture has no way to
  reset it to SQL `NULL`**. To point at a different conversation, write the new value; to
  retire a dead one, set `session_id = ""` — note this stores an **empty string**, not
  `NULL`. Treat empty the same as unset everywhere: the resume glob can't match it, so it's
  functionally "no handle". Rarely needed anyway — the resume step re-globs for the
  transcript before trusting any handle, so a stale handle never yields a false resume.

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

1. Populate the front matter from the **live working context** — read `repo_url`,
   `branch`, `head` from the actual checkout (`git rev-parse`, `git branch --show-current`),
   `machine` / `working_dir` from the host, and the resumable `session_id` per *The
   resumable handle* above — not from memory.
2. Assemble the TOML in memory (no on-disk file needed).
3. Call `session_capture(toml_text)`. It returns `{id, session_id, status, created, reembedded}`.
4. **First capture only:** the front matter has no `id`, so the server **mints
   one** and returns it (`created: true`). **Retain that `id` for this work-thread** —
   stash it in agent project memory, or plan to re-discover it via
   `session_lookup(branch="…")` / `session_search` — and **include it on every later
   capture.** The `id` makes the call *update* the same record (`created: false`);
   re-embedding happens only if `title`/`goal`/`summary`/`resume_context` changed.

   > ⚠️ **Omitting `id` on a re-capture creates a duplicate session, not an
   > update.** The "never author `id`" rule means *never invent one* — only ever
   > re-send the exact value the server handed you. (`session_id` is a separate,
   > optional resumable handle — not the upsert key; omitting it never duplicates.)

   > ⚠️ **A record whose `id` you've lost** — you didn't stash it, or you're picking the
   > thread up on another machine — takes the insert path on a straight re-capture and
   > mints a *duplicate*, orphaning the existing DB row. First recover the row's `id`
   > (`session_lookup(branch="…")` or `session_search`) and put it in the TOML's `id =`
   > line; then capture.

5. Don't author provenance — the server stamps `source` / `source_node`.

## Resuming a session

- On a resume cue, locate the session first:
  - by branch → `session_lookup(branch="<branch>")` (on a branch tie, newest-updated wins);
  - by id → `session_lookup(id=<id>)`;
  - fuzzy ("the session where I chased the flaky invoice test") → `session_search(query=…)`,
    then `session_lookup` the best hit.
- `session_lookup` *fetches* the stored record; it does not resume execution.
- **Read `resume_context` + `next_actions` + `blockers` before acting.** Reconstruct the
  working state from `repo_url` / `branch` / `head` rather than guessing.

### Resuming the actual conversation from the CLI

`session_lookup` restores the *work-log*, not the chat. To get the original Claude Code
**transcript** back you run `claude --resume` yourself — there is no resume wrapper, and the
two ids are **different namespaces**:

> ⚠️ **`claude --resume <ob-id>` does NOT work.** The OB integer `id` is the record key;
> `claude --resume` wants the *harness conversation id*, which is stored in the record's
> `session_id` field. Passing the OB `id` (or a session's title) just errors with
> "No conversation found".

Manual resume, search-driven:

1. **Find it:** `session_search(query=…)` to discover, then `session_lookup(id=…)` for the
   full record — or `session_lookup(id=…)` / `session_lookup(branch=…)` directly if you
   already know it.
2. **Read three fields** off the record: `machine` (which host), `working_dir` (which
   directory), `session_id` (the harness conversation id).
3. **On that `machine`**, run `claude --resume <session_id>` — it resolves the transcript by
   id, so `cd` isn't required, but start from `working_dir` so the resumed work lands in the
   right project. Transcripts are machine-local, so this only works on the host that
   recorded it.

**No transcript available** — `session_id` is unset or empty, you're on a different machine,
or it was pruned/compacted — means **there is no scrollback**. Start a fresh `claude` and rebuild
from the work-log (`resume_context` + `next_actions` + `blockers`), checking out
`repo_url` / `branch` / `head`. Say plainly that scrollback wasn't available and the context
was reconstructed from the session record.

## Searching & listing

- "What's awaiting review / blocked / active" → `session_list(status=…)` (pure SQL
  filter; also filters by `repo_url`, `branch`, `agent`, `tag`, `linked_issue`, `since`,
  `until`).
- Fuzzy recall over title/goal/summary/resume_context → `session_search(query, …)`
  (semantic; optional `status` / `repo_url` / `tag` pre-filters).

## Lifecycle

- Quick transitions (e.g. mark `done` after a PR merges, or `blocked` when stuck) →
  `session_update_status(id, status)`. Usable from any surface with no checkout; it writes
  the new `status` straight to the canonical store and returns `{id, status}`. There is no
  file to reconcile.

## Honesty guardrails

These directly counter the "agent asserts success about its own state" failure pattern.

- **Never claim a session was captured/updated unless the tool returned success.** Surface
  the actual return (`created`, `reembedded`, `status`).
- If a write fails or provenance can't be stamped, **say so plainly** — don't paper over it.
- **Don't fabricate** `id`s, statuses, or artifact refs — report only what the
  tools return (don't claim an artifact landed unless the capture succeeded).
- **Don't claim a conversation is resumable** unless `session_id` is set (non-empty) *and*
  its transcript exists on this machine. Report what's actually known — host, dir, and
  `session_id` (or "no resumable transcript recorded") — and let the human resume.

## Anti-patterns

- Don't shove session data into `thoughts` (or free-form memories into sessions).
- Don't mutate sessions with raw SQL against the `sessions` schema — go through
  `session_capture` / `session_update_status`.
- Don't omit `id` when re-capturing (you'll mint a duplicate).
- Don't stamp `session_id` from `CLAUDE_CODE_SESSION_ID` unchecked — confirm a
  `<session_id>.jsonl` transcript exists first (glob `~/.claude/projects/*/`); an id with no
  transcript won't resume. Leave it unset rather than guess.
- Don't author nested `[identity]` / `[where]` / `[state_for_resuming]` blocks —
  the schema is flat.
- Don't author server-stamped fields (`source`, `content_hash`, …).
- Don't pin embedding-model or dimension assumptions in session tooling — sessions
  follow whatever the Open Brain deployment uses.
