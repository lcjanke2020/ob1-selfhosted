// hermetic unit tests for session TOML parsing + content hashing.
// No DB, no network: pure logic over session_toml.ts.

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { computeContentHash, parseSessionToml } from "./session_toml.ts";

Deno.test("parseSessionToml maps front matter and artifacts to columns", () => {
  const toml = `session_id = "11111111-1111-1111-1111-111111111111"
title = "Fix flaky tests"
goal = "Stabilize CI"
agent = "claude-code"
repo_url = "https://github.com/x/y"
branch = "main"
status = "awaiting_review"
workspace_id = "sensitive"
visibility = "personal"
session_date = "2026-06-07"
started_at = 2026-06-07T10:00:00Z
tags = ["ci", "flaky"]
linked_issues = ["PROJ-123", "PROJ-7"]
next_actions = ["rerun pipeline"]
summary = "Did stuff"
resume_context = "Pick up at step 3"

[[artifacts]]
kind = "pr"
title = "#42"
detail = "the fix"

[[artifacts]]
kind = "code"
title = "server/x.ts"
`;
  const { session, artifacts, rawToml } = parseSessionToml(toml);

  // session_id is now a free-form resumable handle (no id field here → null key).
  assertEquals(session.id, null);
  assertEquals(session.session_id, "11111111-1111-1111-1111-111111111111");
  assertEquals(session.title, "Fix flaky tests");
  assertEquals(session.goal, "Stabilize CI");
  assertEquals(session.repo_url, "https://github.com/x/y");
  assertEquals(session.branch, "main");
  assertEquals(session.status, "awaiting_review");
  assertEquals(session.workspace_id, "sensitive");
  assertEquals(session.project_id, null);
  assertEquals(session.visibility, "personal");
  assertEquals(session.session_date, "2026-06-07");
  // TOML offset-datetime parses to Date → ISO string (TZ-independent: has Z).
  assertEquals(session.started_at, "2026-06-07T10:00:00.000Z");
  assertEquals(session.tags, ["ci", "flaky"]);
  assertEquals(session.linked_issues, ["PROJ-123", "PROJ-7"]);
  assertEquals(session.next_actions, ["rerun pipeline"]);
  assertEquals(session.summary, "Did stuff");
  assertEquals(session.resume_context, "Pick up at step 3");

  // raw_toml is the verbatim historical input; structured columns are canonical.
  assertEquals(rawToml, toml);

  // Artifacts keep authoring order via position; missing detail → null.
  assertEquals(artifacts.length, 2);
  assertEquals(artifacts[0], {
    position: 0,
    kind: "pr",
    title: "#42",
    detail: "the fix",
  });
  assertEquals(artifacts[1], {
    position: 1,
    kind: "code",
    title: "server/x.ts",
    detail: null,
  });
});

// Regression: the exact repro that silently came back as artifacts: [].
// A `[[artifacts]]` (plural) block with kind/title/detail must now round-trip.
Deno.test("parseSessionToml ingests [[artifacts]] kind/title/detail (strict artifacts parsing)", () => {
  const toml = `title = "Smoke test"

[[artifacts]]
kind = "note"
title = "Tool inventory"
detail = "session_capture, session_list, ... exposed on both connections."
`;
  const { artifacts } = parseSessionToml(toml);
  assertEquals(artifacts.length, 1);
  assertEquals(artifacts[0], {
    position: 0,
    kind: "note",
    title: "Tool inventory",
    detail: "session_capture, session_list, ... exposed on both connections.",
  });
});

Deno.test("parseSessionToml rejects a single [artifacts] table", () => {
  assertThrows(
    () =>
      parseSessionToml(
        `title = "t"\n[artifacts]\nkind = "doc"\ntitle = "README"`,
      ),
    Error,
    "array of tables",
  );
});

Deno.test("parseSessionToml accepts a complete strictly typed document", () => {
  const { session, artifacts } = parseSessionToml(`id = 42
session_id = "conversation/42"
title = "Complete document"
session_date = 2026-07-29
goal = "Exercise every field"
agent = "codex"
agent_version = "5"
harness = "Codex"
machine = "workstation"
working_dir = "/src/openbrain"
repo_url = "https://example.invalid/openbrain"
branch = "main"
head = "abc123"
worktree = "/src/openbrain"
started_at = 2026-07-29T10:00:00Z
last_update = 2026-07-29T11:00:00Z
ended_at = 2026-07-29T12:00:00Z
status = "done"
tags = ["validation", "sessions"]
linked_issues = ["PROJ-545"]
related_sessions = ["7"]
next_actions = ["ship"]
blockers = []
resume_context = "Nothing remains."
summary = "All fields survived strict parsing."
workspace_id = "default"
project_id = "openbrain"
visibility = "project"

[[artifacts]]
kind = "pr"
title = "PR #63"
detail = "Strict session TOML validation"
`);

  assertEquals(session.id, 42);
  assertEquals(session.session_id, "conversation/42");
  assertEquals(session.status, "done");
  assertEquals(session.tags, ["validation", "sessions"]);
  assertEquals(session.blockers, []);
  assertEquals(session.workspace_id, "default");
  assertEquals(session.project_id, "openbrain");
  assertEquals(session.visibility, "project");
  assertEquals(artifacts, [{
    position: 0,
    kind: "pr",
    title: "PR #63",
    detail: "Strict session TOML validation",
  }]);
});

Deno.test("parseSessionToml rejects invalid scalar and collection types", () => {
  const invalidScalars = [
    ["title", "title = 7"],
    ["session_id", "session_id = false"],
    ["goal", "goal = 7"],
    ["agent", "agent = true"],
    ["agent_version", "agent_version = 5"],
    ["harness", "harness = false"],
    ["machine", "machine = 7"],
    ["working_dir", "working_dir = false"],
    ["repo_url", "repo_url = 7"],
    ["branch", "branch = false"],
    ["head", "head = 7"],
    ["worktree", "worktree = false"],
    ["resume_context", "resume_context = 7"],
    ["summary", "summary = false"],
    ["started_at", "started_at = 7"],
    ["last_update", "last_update = false"],
    ["ended_at", "ended_at = 7"],
    ["session_date", "session_date = false"],
  ];
  for (const [field, declaration] of invalidScalars) {
    const toml = field === "title"
      ? declaration
      : `title = "t"\n${declaration}`;
    assertThrows(
      () => parseSessionToml(toml),
      Error,
      field,
    );
  }

  const listFields = [
    "tags",
    "linked_issues",
    "related_sessions",
    "next_actions",
    "blockers",
  ];
  for (const field of listFields) {
    assertThrows(
      () => parseSessionToml(`title = "t"\n${field} = "scalar"`),
      Error,
      `${field} must be an array of strings`,
    );
    assertThrows(
      () => parseSessionToml(`title = "t"\n${field} = ["ok", 7]`),
      Error,
      `${field}[1] must be a string`,
    );
    assertThrows(
      () => parseSessionToml(`title = "t"\n${field} = [{ value = "x" }]`),
      Error,
      `${field}[0] must be a string`,
    );
  }
});

Deno.test("parseSessionToml shares the bounded scope-id contract", () => {
  assertEquals(
    parseSessionToml('title = "scope"\nworkspace_id = "  default  "')
      .session.workspace_id,
    "default",
  );
  assertThrows(
    () => parseSessionToml('title = "scope"\nworkspace_id = "   "'),
    Error,
    "workspace_id must not be empty",
  );
  assertThrows(
    () =>
      parseSessionToml(
        `title = "scope"\nproject_id = "${"x".repeat(129)}"`,
      ),
    Error,
    "project_id must be at most 128 characters",
  );
});

Deno.test("parseSessionToml rejects malformed artifacts without rewriting them", () => {
  const malformed = [
    ['artifacts = "scalar"', "array of tables"],
    ["artifacts = [7]", "artifacts[0] must be a table"],
    [
      'artifacts = [{ kind = 7, title = "x" }]',
      "artifacts[0].kind must be a string",
    ],
    [
      'artifacts = [{ kind = "pr", title = false }]',
      "artifacts[0].title must be a string",
    ],
    [
      'artifacts = [{ kind = "pr", title = "x", detail = 7 }]',
      "artifacts[0].detail must be a string",
    ],
    [
      'artifacts = [{ kind = " ", title = "x" }]',
      "requires non-empty string fields",
    ],
  ];
  for (const [declaration, message] of malformed) {
    assertThrows(
      () => parseSessionToml(`title = "t"\n${declaration}`),
      Error,
      message,
    );
  }
});

Deno.test("parseSessionToml parses id and a free-form session_id handle", () => {
  // id round-trips as the canonical key; session_id is no longer UUID-validated.
  const { session } = parseSessionToml(
    `title = "t"\nid = 42\nsession_id = "claude-code/abc-123"`,
  );
  assertEquals(session.id, 42);
  assertEquals(session.session_id, "claude-code/abc-123");

  // a quoted integer is tolerated for id.
  assertEquals(parseSessionToml(`title = "t"\nid = "7"`).session.id, 7);
});

Deno.test("parseSessionToml tolerates partial TOML (title only)", () => {
  const { session, artifacts } = parseSessionToml(`title = "Only title"`);
  assertEquals(session.title, "Only title");
  assertEquals(session.status, null); // omitted → null (upsert defaults/keeps)
  assertEquals(session.goal, null);
  assertEquals(session.tags, []);
  assertEquals(session.linked_issues, []);
  assertEquals(session.related_sessions, []);
  assertEquals(session.next_actions, []);
  assertEquals(session.blockers, []);
  assertEquals(artifacts, []);
});

// Unknown top-level keys are rejected rather than silently dropped. That is
// load-bearing for scope: a misspelled workspace field must not become an
// omitted scope and widen a write into the default workspace. Provenance and
// ownership remain server-authored.
Deno.test("parseSessionToml rejects unknown and server-authored fields", () => {
  for (
    const field of [
      'source = "evil"',
      'source_node = "attacker"',
      'ingested_path = "/etc/passwd"',
      "needs_file_sync = true",
      'workpace_id = "sensitive"',
    ]
  ) {
    assertThrows(
      () => parseSessionToml(`title = "P"\n${field}\n`),
      Error,
      "unknown top-level field",
    );
  }
  assertThrows(
    () => parseSessionToml('title = "P"\nowner_subject = "attacker"'),
    Error,
    "server-stamped",
  );
});

Deno.test("parseSessionToml supports a +++-fenced front-matter block", () => {
  const fenced = `+++
title = "Fenced"
tags = ["x"]
+++

# Body prose here — deliberately NOT valid TOML: { ] (
`;
  const { session, rawToml } = parseSessionToml(fenced);
  assertEquals(session.title, "Fenced");
  assertEquals(session.tags, ["x"]);
  assertEquals(rawToml, fenced); // body preserved, never parsed as TOML
});

Deno.test("parseSessionToml validates and normalizes session dates", () => {
  const { session } = parseSessionToml(`title = "Dates"
session_date = "2026-07-29T23:30:00-04:00"
started_at = "2026-07-29"
last_update = "2026-07-29T12:34:56.789-04:00"
ended_at = 2026-07-29T17:00:00Z
`);
  assertEquals(session.session_date, "2026-07-30");
  assertEquals(session.started_at, "2026-07-29T00:00:00.000Z");
  assertEquals(session.last_update, "2026-07-29T12:34:56.789-04:00");
  assertEquals(session.ended_at, "2026-07-29T17:00:00.000Z");

  const invalid = [
    ["session_date", 'session_date = "2026-02-30"'],
    ["started_at", 'started_at = "2026-07-29T10:00:00"'],
    ["started_at", 'started_at = "2026-07-29T24:00:00Z"'],
    ["last_update", 'last_update = "not-a-date"'],
    ["last_update", 'last_update = "2026-07-29T10:00:00+16:00"'],
    ["last_update", 'last_update = "0001-01-01T00:00:00+15:59"'],
    ["started_at", 'started_at = "9999-12-31T23:59:59-15:59"'],
    ["session_date", 'session_date = "0001-01-01T00:00:00+15:59"'],
    ["session_date", 'session_date = "9999-12-31T23:59:59-15:59"'],
    ["ended_at", 'ended_at = ""'],
    ["ended_at", "ended_at = 7"],
  ];
  for (const [field, declaration] of invalid) {
    assertThrows(
      () => parseSessionToml(`title = "Dates"\n${declaration}`),
      Error,
      field,
    );
  }
});

Deno.test("parseSessionToml validates bare TOML dates before Date coercion", () => {
  const { session } = parseSessionToml(`title = "Bare dates"
session_date = 2026-07-29
"started_at" = 2026-07-29 10:00:00-04:00
last_update = 2026-07-29T12:34:56+15:59 # PostgreSQL's largest accepted hour
ended_at = 2026-07-29T17:00:00Z
`);
  assertEquals(session.session_date, "2026-07-29");
  assertEquals(session.started_at, "2026-07-29T14:00:00.000Z");
  assertEquals(session.last_update, "2026-07-28T20:35:56.000Z");
  assertEquals(session.ended_at, "2026-07-29T17:00:00.000Z");

  const invalid = [
    ["session_date", "session_date = 2026-02-30"],
    ["started_at", "started_at = 2026-02-30 10:00:00Z"],
    ["started_at", "started_at = 2026-07-29T10:00:00"],
    ["started_at", "started_at = 2026-07-29 10:00:00"],
    ["last_update", "last_update = 2026-07-29 10:00:00+16:00"],
    ["ended_at", "ended_at = 0001-01-01T00:00:00+15:59"],
    ["ended_at", "ended_at = 9999-12-31T23:59:59-15:59"],
  ];
  for (const [field, declaration] of invalid) {
    assertThrows(
      () => parseSessionToml(`title = "Bare dates"\n${declaration}`),
      Error,
      field,
    );
  }
});

Deno.test("Date-valued timestamps fail closed when raw scanning misses a key", () => {
  const escapedKey = String.raw`title = "Scanner miss"
"started\u005fat" = 2026-07-29T10:00:00Z
`;
  assertThrows(
    () => parseSessionToml(escapedKey),
    Error,
    "started_at",
  );
});

Deno.test("bare local datetimes reject independently of the host timezone", () => {
  const originalTimezone = Deno.env.get("TZ");
  try {
    for (const timezone of ["UTC", "Etc/GMT+4"]) {
      Deno.env.set("TZ", timezone);
      for (const field of ["session_date", "started_at"]) {
        assertThrows(
          () =>
            parseSessionToml(
              `title = "Local datetime"\n${field} = 2026-07-29T10:00:00`,
            ),
          Error,
          field,
        );
      }
    }
  } finally {
    if (originalTimezone === undefined) Deno.env.delete("TZ");
    else Deno.env.set("TZ", originalTimezone);
  }
});

Deno.test("bare TOML date validation ignores comments and string contents", () => {
  const { session } = parseSessionToml(`title = "Scanner boundaries"
# last_update = 2026-02-30
summary = "A literal example: started_at = 2026-02-30T10:00:00Z"
resume_context = '''
session_date = 2026-02-30
'''
goal = """
An example must not be treated as an assignment:
ended_at = 2026-02-30T10:00:00Z
"""
last_update = 2026-07-29T17:00:00Z # ended_at = 2026-02-30
`);
  assertEquals(session.last_update, "2026-07-29T17:00:00.000Z");
});

Deno.test("parseSessionToml rejects malformed input", () => {
  assertThrows(() => parseSessionToml(`goal = "no title"`), Error, "title");
  assertThrows(
    () => parseSessionToml(`title = "t"\nstatus = "nope"`),
    Error,
    "invalid status",
  );
  // id (the server-assigned canonical key) must be a positive integer.
  assertThrows(
    () => parseSessionToml(`title = "t"\nid = "abc"`),
    Error,
    "positive integer",
  );
  assertThrows(
    () => parseSessionToml(`title = "t"\nid = -3`),
    Error,
    "positive integer",
  );
  // Unsafe integer (> 2^53-1) is rejected, not silently rounded into mis-targeting.
  assertThrows(
    () => parseSessionToml(`title = "t"\nid = 9007199254740993`),
    Error,
    "2^53",
  );
  // Regression guard: the old singular spelling is rejected loudly (was silently dropped).
  assertThrows(
    () =>
      parseSessionToml(`title = "t"\n[[artifact]]\nkind = "pr"\ntitle = "x"`),
    Error,
    "singular",
  );
  // Missing required title → loud failure, not a dropped block.
  assertThrows(
    () => parseSessionToml(`title = "t"\n[[artifacts]]\nkind = "pr"`),
    Error,
    "requires non-empty string fields",
  );
  // Unknown field (e.g. the legacy `ref`) → loud failure.
  assertThrows(
    () =>
      parseSessionToml(
        `title = "t"\n[[artifacts]]\nkind = "pr"\ntitle = "x"\nref = "#1"`,
      ),
    Error,
    "unknown field",
  );
});

Deno.test("computeContentHash is deterministic over the embed-source fields", async () => {
  const mk = (summary: string, tags: string) =>
    parseSessionToml(
      `title = "T"\ngoal = "G"\nsummary = "${summary}"\nresume_context = "R"\ntags = [${tags}]`,
    ).session;

  const h1 = await computeContentHash(mk("S", `"a", "b"`));
  const h2 = await computeContentHash(mk("S", `"a", "b"`));
  assertEquals(h1, h2);
  assertEquals(h1.length, 64); // hex SHA-256

  // tags are not part of the embed source → reordering them doesn't re-embed.
  const hTagsReordered = await computeContentHash(mk("S", `"b", "a"`));
  assertEquals(h1, hTagsReordered);

  // changing summary changes the hash → triggers a re-embed.
  const hSummary = await computeContentHash(mk("DIFFERENT", `"a", "b"`));
  assertNotEquals(h1, hSummary);
});
