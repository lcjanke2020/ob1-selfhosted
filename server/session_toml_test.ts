// hermetic unit tests for session TOML parsing + content hashing.
// No DB, no network: pure logic over session_toml.ts.

import { assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert@1";
import { computeContentHash, parseSessionToml } from "./session_toml.ts";

Deno.test("parseSessionToml maps front matter and artifacts to columns", () => {
  const toml = `session_id = "11111111-1111-1111-1111-111111111111"
title = "Fix flaky tests"
goal = "Stabilize CI"
agent = "claude-code"
repo_url = "https://github.com/x/y"
branch = "main"
status = "awaiting_review"
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
  assertEquals(session.session_date, "2026-06-07");
  // TOML offset-datetime parses to Date → ISO string (TZ-independent: has Z).
  assertEquals(session.started_at, "2026-06-07T10:00:00.000Z");
  assertEquals(session.tags, ["ci", "flaky"]);
  assertEquals(session.linked_issues, ["PROJ-123", "PROJ-7"]);
  assertEquals(session.next_actions, ["rerun pipeline"]);
  assertEquals(session.summary, "Did stuff");
  assertEquals(session.resume_context, "Pick up at step 3");

  // raw_toml is the verbatim input (lets the DB hand back the canonical doc).
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

// A single `[artifacts]` table (not array-of-tables) is tolerated as one entry.
Deno.test("parseSessionToml tolerates a single [artifacts] table", () => {
  const { artifacts } = parseSessionToml(
    `title = "t"\n[artifacts]\nkind = "doc"\ntitle = "README"`,
  );
  assertEquals(artifacts, [{
    position: 0,
    kind: "doc",
    title: "README",
    detail: null,
  }]);
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

Deno.test("parseSessionToml ignores caller-supplied provenance fields", () => {
  const { session } = parseSessionToml(`title = "P"
source = "evil"
source_node = "attacker"
ingested_path = "/etc/passwd"
needs_file_sync = true
`);
  const asRec = session as unknown as Record<string, unknown>;
  assertEquals(asRec.source, undefined);
  assertEquals(asRec.source_node, undefined);
  assertEquals(asRec.ingested_path, undefined);
  assertEquals(asRec.needs_file_sync, undefined);
  assertEquals(session.title, "P");
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
    "missing required",
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
