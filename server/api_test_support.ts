// Hand-rolled fakes shared by services_test.ts and the api_*_test.ts files.
// Same philosophy as db_pool_test.ts: no real database, no network — model
// only the surface the code under test touches. The filename deliberately
// does NOT match Deno's *_test.ts discovery pattern, so this file is only
// ever imported, never run as a suite.

import type { Pool } from "postgres";
import type { ServiceDeps } from "./services.ts";

// Per-test SQL dispatcher. Return rows for statements the test expects;
// return undefined to fall through (queryArray treats that as a no-op result
// — the getClient() validate-on-borrow probe, BEGIN/COMMIT, artifact
// DELETE/INSERT — while queryObject treats it as an unexpected query and
// throws, so a test can't silently satisfy a read it didn't script).
export type QueryHandler = (
  sql: string,
  params: unknown[],
) => { rows: unknown[] } | undefined;

export class FakeClient {
  constructor(private handler: QueryHandler) {}

  queryArray(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    return Promise.resolve(this.handler(sql, params ?? []) ?? { rows: [] });
  }

  queryObject(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const r = this.handler(sql, params ?? []);
    // Every scoped service resolves the registry before doing work. Keep the
    // default legacy workspace implicit in existing hermetic tests; focused
    // scope tests can override by returning their own row (or `{rows: []}`).
    if (!r && sql.includes("FROM memory_scope.workspace AS w")) {
      return Promise.resolve({
        rows: [{
          default_visibility: "workspace",
          personal_only: false,
          project_exists: true,
        }],
      });
    }
    if (!r) {
      return Promise.reject(
        new Error(
          `FakeClient: unscripted queryObject: ${sql.trim().slice(0, 80)}`,
        ),
      );
    }
    return Promise.resolve(r);
  }

  release(): void {}
}

export class FakePool {
  connectCalls = 0;
  constructor(private handler: QueryHandler) {}
  connect(): Promise<FakeClient> {
    this.connectCalls++;
    return Promise.resolve(new FakeClient(this.handler));
  }
}

export const asPool = (p: FakePool): Pool => p as unknown as Pool;

// A valid 768-dim embedding is irrelevant to these tests; 3 floats keeps
// assertion output readable. The query layer only joins it into a pgvector
// literal.
export const FAKE_VECTOR = [0.1, 0.2, 0.3];

export type RecordingDeps = ServiceDeps & {
  embedCalls: string[];
  extractCalls: string[];
};

export function makeDeps(overrides: Partial<ServiceDeps> = {}): RecordingDeps {
  const embedCalls: string[] = [];
  const extractCalls: string[] = [];
  return {
    embedCalls,
    extractCalls,
    embed: overrides.embed ?? ((text) => {
      embedCalls.push(text);
      return Promise.resolve([...FAKE_VECTOR]);
    }),
    extractMetadata: overrides.extractMetadata ?? ((text) => {
      extractCalls.push(text);
      return Promise.resolve({
        metadata: { type: "observation", topics: ["testing"] },
        classifier: {
          schema_version: 1 as const,
          endpoint: "primary" as const,
          model: "test-local-model",
        },
        degradation_events: [],
      });
    }),
  };
}

// deps whose embed always fails — the "Ollama is down" case.
export function makeEmbedDownDeps(message = "Ollama embed failed: 500 down") {
  const deps = makeDeps({
    embed: () => Promise.reject(new Error(message)),
  });
  return { deps, message };
}
