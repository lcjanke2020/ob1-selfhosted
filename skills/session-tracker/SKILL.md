---
name: session-tracker
description: "Use when starting, resuming, or wrapping up an agent/coding work session — and on cues like \"where did I leave off\", \"resume the X work\", \"what's awaiting review\", \"save this session\", \"what was I doing on <branch>\". Captures and restores structured session state via Open Brain's session_* MCP tools. The canonical artifact is a flat TOML front-matter file; the DB is a derived index."
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

- The **canonical artifact is a flat TOML front-matter file** wrapped in `+++` delimiter
  lines (a `+++` before and after the TOML). You author/update the **file**, then sync it
  to the DB with `session_capture`.
- The **DB is a derived index** — re-ingestible from the files, survives a DB wipe.
  Never hand-edit the DB; edit the file and re-`capture`.
- Keep session files in one directory that your machines share (a synced folder, a git
  repo — anything). One TOML file per session; name it stably for humans (e.g.
  `2026-06-08-rate-limit-gateway.toml`). The DB keys on the in-file `id` (see
  Capturing), **not** the filename, so renaming a file is harmless as long as its
  `id` line is kept. If the session directory isn't present on this machine,
  **stop and ask the user** — don't invent a path.

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
| Resumable handle | `session_id` — optional, free-form; the resumable id your surface exposes (if any), else omit. **NOT** the key. |

`tags`, `linked_issues`, `related_sessions`, `next_actions`, and `blockers` are
**array-valued** (`key = [ ... ]`) — write the bare key, never `key[]`.

- **`status` enum:** `active | awaiting_review | blocked | done | abandoned`.
- **Timestamps** are ISO-8601. Date-only (`"2026-06-08"`) is accepted and expanded to
  midnight UTC; full timestamps round-trip as given.
- **Embedded-for-search content** is `title` / `goal` / `summary` / `resume_context`;
  the server re-embeds only when that content changes (`content_hash`).

**Server-stamped — never author these:** `source`, `source_node`, `ingested_path`,
`needs_file_sync`, `content_hash`, `created_at`, `updated_at`. The server sets `source`
/ `source_node` from the transport (tailnet x-brain-key vs OAuth door) — don't write a
`source` by hand.

**`[[artifacts]]`** attach references — a PR, a note, a file, a branch — to the session.
Each is a TOML table in an `[[artifacts]]` array: `kind` and `title` are **required**,
`detail` is optional; the server assigns `position` from array order (don't author it).
Unknown fields, or a singular `[[artifact]]`, are **rejected with an error** — so once
`session_capture` returns success, the artifacts did land.

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

# when
started_at = "2026-06-07T14:30:00Z"
last_update = "2026-06-08T09:15:00Z"
ended_at = "2026-06-08T09:15:00Z"
session_date = "2026-06-08"

# what
goal = "Add per-client rate limiting at the gateway, backed by Redis, behind a feature flag."
tags = ["api-gateway", "rate-limiting", "redis"]
linked_issues = ["ACME-1487", "ACME-1490"]
related_sessions = ["c1d2e3f4-5a6b-7c8d-9e0f-1a2b3c4d5e6f"]

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
   not from memory.
2. Write the TOML file into the session directory.
3. Call `session_capture(toml_text)`. It returns `{id, session_id, status, created, reembedded}`.
4. **First capture only:** the front matter has no `id`, so the server **mints
   one** and returns it (`created: true`). **Write that `id` back into the file's
   front matter.** On every later capture the `id` line makes the call *update*
   the same record (`created: false`); re-embedding happens only if `title`/`goal`/
   `summary`/`resume_context` changed.

   > ⚠️ **Omitting `id` on a re-capture creates a duplicate session, not an
   > update.** The "never author `id`" rule means *never invent one* — only ever
   > write back the exact value the server handed you. (`session_id` is a separate,
   > optional resumable handle — not the upsert key; omitting it never duplicates.)

   > ⚠️ **A session file that predates the `id` key** carries an old value in
   > `session_id` and has no `id` line — so a straight re-capture takes the insert
   > path and mints a *duplicate*, orphaning the existing DB row. First recover
   > the row's `id` (`session_lookup(branch="…")` or `session_search`) and write
   > it into the file's `id =` line; then capture.

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

## Searching & listing

- "What's awaiting review / blocked / active" → `session_list(status=…)` (pure SQL
  filter; also filters by `repo_url`, `branch`, `agent`, `tag`, `linked_issue`, `since`,
  `until`).
- Fuzzy recall over title/goal/summary/resume_context → `session_search(query, …)`
  (semantic; optional `status` / `repo_url` / `tag` pre-filters).

## Lifecycle

- Quick transitions (e.g. mark `done` after a PR merges, or `blocked` when stuck) →
  `session_update_status(id, status)`. Usable from mobile with no checkout.
- A status flip sets **`needs_file_sync=true`** and the DB record's `status` now **leads
  the file** (the file's `status` is stale until reconciled). Next time the
  repo/file is in front of you, update the file's `status` + `last_update` and re-`capture`
  (carrying the `id`) to reconcile.

## Honesty guardrails

These directly counter the "agent asserts success about its own state" failure pattern.

- **Never claim a session was captured/updated unless the tool returned success.** Surface
  the actual return (`created`, `reembedded`, `status`).
- If a write fails or provenance can't be stamped, **say so plainly** — don't paper over it.
- **Don't fabricate** `id`s, statuses, or artifact refs — report only what the
  tools return (don't claim an artifact landed unless the capture succeeded).

## Anti-patterns

- Don't shove session data into `thoughts` (or free-form memories into sessions).
- Don't hand-edit the DB — edit the **file** and re-`capture`.
- Don't omit `id` when re-capturing (you'll mint a duplicate).
- Don't author nested `[identity]` / `[where]` / `[state_for_resuming]` blocks —
  the schema is flat.
- Don't author server-stamped fields (`source`, `content_hash`, …).
- Don't pin embedding-model or dimension assumptions in session tooling — sessions
  follow whatever the Open Brain deployment uses.
