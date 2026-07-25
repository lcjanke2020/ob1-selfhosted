# Thought provenance

Thought provenance has two trust levels. Open Brain can verify how an
authenticated capture reached the server, but it cannot independently verify the
human, agent, repository, or branch named by that caller. The persisted metadata
makes that distinction structural rather than relying on naming convention.

## Capture input

Both MCP `capture_thought` and REST `POST /api/v1/thoughts` accept the same
optional `provenance` object:

```json
{
  "content": "The release checklist now includes a rollback rehearsal.",
  "provenance": {
    "author": "release engineering",
    "agent": "codex",
    "repo": "example/open-brain",
    "branch": "docs/release-checklist"
  }
}
```

All four fields are optional, but an object that is present must contain at
least one of them. Values are trimmed, must be non-empty strings, and are
limited to 1,024 characters each. Unknown fields are rejected rather than
silently dropped. The server does not accept a schema version, transport, auth
door, or subject from the caller. When no claim is known, omit `provenance`
entirely; `null` and an empty object are not accepted.

| Input field | Meaning                                        | Trust            |
| ----------- | ---------------------------------------------- | ---------------- |
| `author`    | Human or stable role behind the capture        | Caller assertion |
| `agent`     | Agent tool and/or model that wrote the thought | Caller assertion |
| `repo`      | Repository URL, slug, or local identifier      | Caller assertion |
| `branch`    | Branch or work-context ref                     | Caller assertion |

Repository and branch are plain bounded identifiers rather than URL/Git-ref
validators: local repositories and non-Git work contexts are valid uses. Do not
put credentials or other secrets in these fields.

## Persisted metadata: schema version 1

For a capture with claims, the metadata contains this versioned object alongside
the existing classification keys:

```json
{
  "type": "observation",
  "topics": ["release"],
  "source": "rest",
  "door": "funnel",
  "sub": "verified-oauth-subject",
  "provenance": {
    "schema_version": 1,
    "caller_asserted": {
      "author": "release engineering",
      "agent": "codex",
      "repo": "example/open-brain",
      "branch": "docs/release-checklist"
    }
  }
}
```

The trust boundary is:

| Persisted key                           | Set by               | Meaning                                                 |
| --------------------------------------- | -------------------- | ------------------------------------------------------- |
| `metadata.source`                       | Server               | Validated transport: `mcp` or `rest`                    |
| `metadata.door`                         | Server               | Auth path: `tailnet` or `funnel`                        |
| `metadata.sub`                          | Server               | Verified OAuth `sub`, or `null` for the shared-key door |
| `metadata.provenance.schema_version`    | Server               | Version of the nested caller-claims contract            |
| `metadata.provenance.caller_asserted.*` | Authenticated caller | Validated but unverified author/work-context claims     |

The top-level `source`, `door`, and `sub` keys remain canonical compatibility
keys; they are not copied from caller input. The metadata extractor is also
prevented from populating any of these reserved keys or `provenance`.

Callers do not submit `schema_version`. Open Brain writes it. A future
incompatible change to the nested key layout must increment the integer;
additive support for a new optional claim can remain within a version only when
old readers continue to interpret every existing key correctly.

## Compatibility and deduplication

- `provenance` is optional. Old rows and new captures without claims have no
  nested key and continue to search, list, fetch, and aggregate unchanged.
- Omitting claims on a duplicate capture leaves an existing nested provenance
  object in place because the JSONB upsert merges only supplied top-level keys.
- Supplying claims on a duplicate capture replaces the previous versioned
  object, matching the existing last-writer-wins behavior of `source`, `door`,
  and `sub`.
- One deduplicated thought row therefore records the most recent explicit
  capture context, not a history of every contributor who submitted identical
  content.

The claims are not promoted to columns. Consumers that inspect metadata
directly should treat a missing `provenance` key as "unclaimed/legacy", never
as a match for an arbitrary author or repository.

## Search filtering

MCP `search_thoughts` and REST `POST /api/v1/thoughts/search` accept the same
optional `filter` object:

```json
{
  "query": "release checklist",
  "filter": {
    "include": {
      "repo": "example/open-brain",
      "branch": "main"
    },
    "exclude": {
      "author": "release engineering",
      "agent": "codex"
    }
  }
}
```

`include` and `exclude` accept the same four fields and bounds as capture-time
claims. Every object that is present must contain at least one field; unknown
fields are rejected. Comparisons are exact and case-sensitive after input
values are trimmed.

The boolean contract is deliberately asymmetric:

- all supplied `include` fields must match the same thought;
- a match on **any** supplied `exclude` field rejects the thought;
- an unclaimed/legacy row fails every include filter;
- an unclaimed/legacy row survives an exclude-only filter because a missing
  field does not equal the excluded value.

The positive side compiles to one nested `metadata @> ...` containment
predicate, which the existing `idx_thoughts_metadata` GIN index supports.
Negative predicates are applied as residual filters; a negated JSONB predicate
alone is not expected to use that index. The search implementation emits no
metadata predicate when `filter` is absent, preserving the historical
unfiltered path.

This filter is intentionally limited to the versioned provenance keys instead
of exposing an open-ended JSON query language. Future workspace/project and
visibility scoping is a separate fail-closed partitioning concern; hybrid
vector/full-text search must apply this same filter contract to every retrieval
leg before ranking and fusion.

## Agent caller policy

Standing agent callers should send values they already know at capture time and
omit unknowns rather than infer them from thought content:

- use a human identity only when the human is actually known; otherwise a stable
  role such as `release engineering` is an honest author claim;
- identify the writing tool/model in `agent` at the precision available to the
  caller;
- read repository and branch from the live checkout when applicable;
- on a duplicate capture with any explicit claim, resend the full set of known
  claims rather than only the fields that changed, because the supplied nested
  claim object replaces the previous one;
- never derive any of these values with the thought metadata classifier.

The session-tracker skill does **not** populate thought provenance. Sessions are
a separate structured work-log with their own `agent`, `repo_url`, and `branch`
fields, and the skill calls `session_*` tools rather than `capture_thought`. If
an agent independently captures a reusable thought while working a session, that
separate `capture_thought` call should include the known provenance claims.
