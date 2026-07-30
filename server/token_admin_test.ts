import { assertEquals } from "@std/assert";
import { parseTokenAdminArgs } from "./token_admin.ts";

Deno.test("token-admin recognizes only an optional trailing JSON flag", () => {
  assertEquals(parseTokenAdminArgs(["list", "--json"]), {
    command: "list",
    value: undefined,
    json: true,
  });
  assertEquals(parseTokenAdminArgs(["create", "client", "--json"]), {
    command: "create",
    value: "client",
    json: true,
  });
  assertEquals(parseTokenAdminArgs(["create", "client", "extra"]), null);
  assertEquals(parseTokenAdminArgs(["revoke", "--json"]), {
    command: "revoke",
    value: undefined,
    json: true,
  });
});

Deno.test("token-admin permits a label spelled exactly --json", () => {
  assertEquals(parseTokenAdminArgs(["create", "--json"]), {
    command: "create",
    value: "--json",
    json: false,
  });
  assertEquals(parseTokenAdminArgs(["create", "--json", "--json"]), {
    command: "create",
    value: "--json",
    json: true,
  });
});
