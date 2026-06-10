// hermetic unit tests for the order_by whitelist (normalizeOrderBy).
// (The provenance-mapping test was removed when sourceFromDoor was dropped in
// favor of storing the transport door directly — see session_queries.ts
// `SessionProvenance.source` and mcp-server.ts `source: auth.door`.)

import { assertEquals } from "jsr:@std/assert@1";
import { normalizeOrderBy } from "./session_toml.ts";

Deno.test("normalizeOrderBy only allows whitelisted columns", () => {
  assertEquals(normalizeOrderBy("last_update"), "last_update");
  assertEquals(normalizeOrderBy("started_at"), "started_at");
  assertEquals(normalizeOrderBy("created_at"), "created_at");
  assertEquals(normalizeOrderBy("title"), "title");
  // Anything off-whitelist (incl. injection attempts) falls back safely.
  assertEquals(
    normalizeOrderBy("status; DROP TABLE sessions.session"),
    "last_update",
  );
  assertEquals(normalizeOrderBy(""), "last_update");
  assertEquals(normalizeOrderBy(undefined), "last_update");
  assertEquals(normalizeOrderBy(null), "last_update");
});
