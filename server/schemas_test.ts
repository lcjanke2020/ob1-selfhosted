// Tests for the shared input-validation schemas. Pure Zod — no
// DB, no network, no env (schemas.ts reads none), so no snapshot/restore
// scaffolding is needed. The byte-cap boundary cases mirror the rationale
// comments in schemas.ts: `.max` measures UTF-16 code units, the `.refine`
// enforces the UTF-8 byte budget.

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  captureThoughtBody,
  fetchThoughtSchema,
  listSessionsQuery,
  listThoughtsQuery,
  MAX_CONTENT_BYTES,
  MAX_PROVENANCE_VALUE_CHARS,
  MAX_SEARCH_QUERY_BYTES,
  searchThoughtsBody,
  sessionCaptureBody,
  sessionIdParam,
  sessionLookupQuery,
  sessionSearchBody,
  sessionUpdateStatusBody,
  THOUGHT_PROVENANCE_SCHEMA_VERSION,
  thoughtIdParam,
} from "./schemas.ts";

Deno.test("byte cap: exactly MAX_CONTENT_BYTES ASCII accepted", () => {
  const r = captureThoughtBody.safeParse({
    content: "a".repeat(MAX_CONTENT_BYTES),
  });
  assert(r.success);
});

Deno.test("byte cap: one byte over rejected", () => {
  const r = captureThoughtBody.safeParse({
    content: "a".repeat(MAX_CONTENT_BYTES + 1),
  });
  assertFalse(r.success);
});

Deno.test("byte cap: multi-byte content under the code-unit cap but over the byte cap rejected", () => {
  // "é" is 1 UTF-16 code unit but 2 UTF-8 bytes: 60 000 of them pass the
  // `.max` fast path (60 000 ≤ 100 000 code units) yet weigh 120 000 bytes —
  // exactly the case the `.refine` exists to catch.
  const r = captureThoughtBody.safeParse({ content: "é".repeat(60_000) });
  assertFalse(r.success);
  assert(
    r.error.issues.some((i) =>
      i.message === `content must be at most ${MAX_CONTENT_BYTES} UTF-8 bytes`
    ),
    "byte-cap refine message expected",
  );
});

Deno.test("byte cap: empty content rejected", () => {
  assertFalse(captureThoughtBody.safeParse({ content: "" }).success);
});

Deno.test("thought provenance: full caller claim set is accepted and trimmed", () => {
  const r = captureThoughtBody.safeParse({
    content: "provenance smoke",
    provenance: {
      author: "  release engineer  ",
      agent: "  codex/gpt  ",
      repo: "  example/open-brain  ",
      branch: "  feature/provenance  ",
    },
  });
  assert(r.success);
  assertEquals(THOUGHT_PROVENANCE_SCHEMA_VERSION, 1);
  assertEquals(r.data.provenance, {
    author: "release engineer",
    agent: "codex/gpt",
    repo: "example/open-brain",
    branch: "feature/provenance",
  });
});

Deno.test("thought provenance: optional, but strict and non-empty when present", () => {
  assert(captureThoughtBody.safeParse({ content: "legacy capture" }).success);
  assert(
    captureThoughtBody.safeParse({
      content: "partial",
      provenance: { agent: "codex" },
    }).success,
  );
  assertFalse(
    captureThoughtBody.safeParse({ content: "x", provenance: {} }).success,
  );
  assertFalse(
    captureThoughtBody.safeParse({ content: "x", provenance: null }).success,
  );
  assertFalse(
    captureThoughtBody.safeParse({
      content: "x",
      provenance: { author: "   " },
    }).success,
  );
  assertFalse(
    captureThoughtBody.safeParse({
      content: "x",
      provenance: { author: 42 },
    }).success,
  );
  assertFalse(
    captureThoughtBody.safeParse({
      content: "x",
      provenance: { actor: "misspelled-author" },
    }).success,
  );
  assertFalse(
    captureThoughtBody.safeParse({
      content: "x",
      provenance: { author: "caller", schema_version: 99 },
    }).success,
  );
  assertFalse(
    captureThoughtBody.safeParse({
      content: "x",
      provenance: { branch: "b".repeat(MAX_PROVENANCE_VALUE_CHARS + 1) },
    }).success,
  );
});

Deno.test("byte cap: toml_text carries its own field name in the message", () => {
  const r = sessionCaptureBody.safeParse({ toml_text: "é".repeat(60_000) });
  assertFalse(r.success);
  assert(
    r.error.issues.some((i) =>
      i.message ===
        `toml_text must be at most ${MAX_CONTENT_BYTES} UTF-8 bytes`
    ),
  );
});

Deno.test("search body: defaults applied", () => {
  const r = searchThoughtsBody.safeParse({ query: "x" });
  assert(r.success);
  assertEquals(r.data.limit, 10);
  assertEquals(r.data.threshold, 0.5);
  assertEquals(r.data.filter, undefined);
});

Deno.test("search body: bounds enforced", () => {
  assertFalse(searchThoughtsBody.safeParse({ query: "" }).success);
  assertFalse(searchThoughtsBody.safeParse({ query: "   " }).success);
  assert(
    searchThoughtsBody.safeParse({
      query: "x".repeat(MAX_SEARCH_QUERY_BYTES),
    }).success,
  );
  assertFalse(
    searchThoughtsBody.safeParse({
      query: "x".repeat(MAX_SEARCH_QUERY_BYTES + 1),
    }).success,
  );
  assertFalse(
    searchThoughtsBody.safeParse({
      query: "é".repeat(MAX_SEARCH_QUERY_BYTES / 2 + 1),
    }).success,
  );
  assertFalse(searchThoughtsBody.safeParse({ query: "x", limit: 0 }).success);
  assertFalse(searchThoughtsBody.safeParse({ query: "x", limit: 101 }).success);
  assertFalse(
    searchThoughtsBody.safeParse({ query: "x", threshold: 1.5 }).success,
  );
});

Deno.test("session search query: shares nonblank UTF-8 byte boundaries", () => {
  assertFalse(sessionSearchBody.safeParse({ query: "" }).success);
  assertFalse(sessionSearchBody.safeParse({ query: "   \t\n" }).success);

  assert(
    sessionSearchBody.safeParse({
      query: "x".repeat(MAX_SEARCH_QUERY_BYTES),
    }).success,
  );
  assertFalse(
    sessionSearchBody.safeParse({
      query: "x".repeat(MAX_SEARCH_QUERY_BYTES + 1),
    }).success,
  );

  // `é` is one UTF-16 code unit but two UTF-8 bytes. The exact byte boundary
  // is accepted and one additional code point is rejected.
  assert(
    sessionSearchBody.safeParse({
      query: "é".repeat(MAX_SEARCH_QUERY_BYTES / 2),
    }).success,
  );
  assertFalse(
    sessionSearchBody.safeParse({
      query: "é".repeat(MAX_SEARCH_QUERY_BYTES / 2 + 1),
    }).success,
  );
});

Deno.test("memory scope: exact upstream fields are strict and bounded", () => {
  const valid = searchThoughtsBody.safeParse({
    query: "private",
    scope: {
      workspace_id: "  sensitive  ",
      visibility: "personal",
    },
  });
  assert(valid.success);
  assertEquals(valid.data.scope, {
    workspace_id: "sensitive",
    visibility: "personal",
  });
  assertFalse(
    searchThoughtsBody.safeParse({
      query: "private",
      scope: { workpace_id: "sensitive" },
    }).success,
  );
  assertFalse(
    searchThoughtsBody.safeParse({
      query: "private",
      scope: { workspace_id: "sensitive", visibility: "private" },
    }).success,
  );
  assertFalse(
    searchThoughtsBody.safeParse({ query: "private", scop: {} }).success,
  );
  assertFalse(
    sessionSearchBody.safeParse({ query: "private", scop: {} }).success,
  );
  assertFalse(
    captureThoughtBody.safeParse({ content: "private", owner_subject: "alice" })
      .success,
  );
});

Deno.test("search filter: include/exclude claims are strict, bounded, and trimmed", () => {
  const r = searchThoughtsBody.safeParse({
    query: "release checklist",
    filter: {
      include: {
        author: "  release engineering  ",
        repo: "  example/open-brain  ",
      },
      exclude: {
        agent: "  codex  ",
        branch: "  archived  ",
      },
    },
  });
  assert(r.success);
  assertEquals(r.data.filter, {
    include: {
      author: "release engineering",
      repo: "example/open-brain",
    },
    exclude: { agent: "codex", branch: "archived" },
  });
});

Deno.test("search filter: optional, but every present object is strict and non-empty", () => {
  assert(searchThoughtsBody.safeParse({ query: "legacy" }).success);
  assert(
    searchThoughtsBody.safeParse({
      query: "included",
      filter: { include: { author: "author-a" } },
    }).success,
  );
  assert(
    searchThoughtsBody.safeParse({
      query: "excluded",
      filter: { exclude: { agent: "agent-a" } },
    }).success,
  );

  const invalidFilters = [
    {},
    { include: {} },
    { exclude: {} },
    { include: { author: "   " } },
    { exclude: { agent: 42 } },
    { include: { actor: "misspelled-author" } },
    { allow: { author: "unknown-filter-side" } },
    {
      exclude: {
        branch: "b".repeat(MAX_PROVENANCE_VALUE_CHARS + 1),
      },
    },
  ];
  for (const filter of invalidFilters) {
    assertFalse(
      searchThoughtsBody.safeParse({ query: "x", filter }).success,
      `expected invalid filter: ${JSON.stringify(filter)}`,
    );
  }
});

Deno.test("list thoughts query: string values coerced, defaults applied", () => {
  const r = listThoughtsQuery.safeParse({ limit: "5", days: "30" });
  assert(r.success);
  assertEquals(r.data.limit, 5);
  assertEquals(r.data.days, 30);
  const empty = listThoughtsQuery.safeParse({});
  assert(empty.success);
  assertEquals(empty.data.limit, 10);
  assertEquals(empty.data.days, undefined);
});

Deno.test("list thoughts query: non-numeric limit rejected", () => {
  assertFalse(listThoughtsQuery.safeParse({ limit: "lots" }).success);
  assertFalse(listThoughtsQuery.safeParse({ days: "0" }).success);
});

Deno.test("list sessions query: order_by whitelisted with default", () => {
  const r = listSessionsQuery.safeParse({});
  assert(r.success);
  assertEquals(r.data.order_by, "last_update");
  assertEquals(r.data.limit, 50);
  assertFalse(
    listSessionsQuery.safeParse({ order_by: "updated_at; DROP TABLE" }).success,
  );
  assert(listSessionsQuery.safeParse({ order_by: "title" }).success);
});

Deno.test("session status body: enum enforced", () => {
  assert(sessionUpdateStatusBody.safeParse({ status: "done" }).success);
  assertFalse(
    sessionUpdateStatusBody.safeParse({ status: "finished" }).success,
  );
});

Deno.test("session lookup query: id or branch required", () => {
  assertFalse(sessionLookupQuery.safeParse({}).success);
  assert(sessionLookupQuery.safeParse({ id: "7" }).success);
  assert(sessionLookupQuery.safeParse({ branch: "main" }).success);
  const byId = sessionLookupQuery.safeParse({ id: "7" });
  assert(byId.success);
  assertEquals(byId.data.id, 7);
});

Deno.test("thought id: MCP fetch and REST path share one UUID contract", () => {
  const cases: unknown[] = [
    "6f6c0d3a-9a0b-4e3e-8f4a-2d1c5b7e9a01",
    "",
    "42",
    "not-a-uuid",
    "6f6c0d3a-9a0b-4e3e-8f4a",
    42,
    null,
    undefined,
  ];
  for (const id of cases) {
    assertEquals(
      fetchThoughtSchema.safeParse({ id }).success,
      thoughtIdParam.safeParse(id).success,
    );
  }
  assert(
    fetchThoughtSchema.safeParse({
      id: "6f6c0d3a-9a0b-4e3e-8f4a-2d1c5b7e9a01",
    }).success,
  );
  assertFalse(fetchThoughtSchema.safeParse({}).success);
});

Deno.test("session id param: positive safe integer, coerced from the path string", () => {
  const r = sessionIdParam.safeParse("12");
  assert(r.success);
  assertEquals(r.data, 12);
  assertFalse(sessionIdParam.safeParse("0").success);
  assertFalse(sessionIdParam.safeParse("-3").success);
  assertFalse(sessionIdParam.safeParse("2.5").success);
  assertFalse(sessionIdParam.safeParse("abc").success);
  // Past 2^53-1 a JS number rounds silently — must reject, not mis-target.
  assertFalse(sessionIdParam.safeParse("999999999999999999999").success);
});
