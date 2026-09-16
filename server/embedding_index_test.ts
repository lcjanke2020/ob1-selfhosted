import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  buildEmbeddingIndex,
  EmbeddingContextError,
  sourceHash,
} from "./embedding_index.ts";

Deno.test("strict overflow splitting covers every grapheme in source order", async () => {
  const source = ("CJK 中文 e\u0301 👩🏽‍🚀 /src/a.ts uuid-ABCD\n").repeat(300) +
    "distinctive tail";
  const successful: string[] = [];
  const attempted: string[] = [];
  const index = await buildEmbeddingIndex(source, ["content"], (text) => {
    attempted.push(text);
    if (text.length > 1000) return Promise.reject(new EmbeddingContextError());
    assert(text.isWellFormed());
    assert(!/^\p{Mark}/u.test(text));
    successful.push(text);
    return Promise.resolve([1, successful.length]);
  }, "contract");
  assertEquals(successful.join(""), source);
  assert(index.vectors.length > 1);
  assert(attempted.length > successful.length);
  assertEquals(index.sourceHash, await sourceHash(source));
  assertEquals(index.sourceBytes, new TextEncoder().encode(source).length);
  assertEquals(index.sourceUnits, source.length);
});

Deno.test("unrelated failure on a late chunk aborts without retry or partial result", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      buildEmbeddingIndex("a".repeat(9000), ["summary"], () => {
        if (++calls === 2) throw new Error("HTTP 400 invalid model option");
        return Promise.resolve([1, 0]);
      }, "contract"),
    Error,
    "invalid model option",
  );
  assertEquals(calls, 2);
});

Deno.test("source, attempt, grapheme and deadline bounds reject explicitly", async () => {
  const overflow = () => Promise.reject(new EmbeddingContextError());
  await assertRejects(
    () => buildEmbeddingIndex("x".repeat(100001), ["content"], overflow, "c"),
    Error,
    "UTF-8 bytes",
  );
  await assertRejects(
    () => buildEmbeddingIndex("e\u0301", ["content"], overflow, "c"),
    Error,
    "one grapheme",
  );
  await assertRejects(
    () => buildEmbeddingIndex("a".repeat(9000), ["content"], overflow, "c"),
    Error,
    "one grapheme",
  );
  await assertRejects(
    () =>
      buildEmbeddingIndex(
        "a",
        ["content"],
        overflow,
        "c",
        performance.now() - 1,
      ),
    Error,
    "deadline",
  );
  await assertRejects(
    () => buildEmbeddingIndex("\ud800", ["content"], overflow, "c"),
    Error,
    "invalid Unicode",
  );
});

Deno.test("more than 128 fitting tiny chunks never produces a partial index", async () => {
  const embed = (text: string) =>
    text.length > 1
      ? Promise.reject(new EmbeddingContextError())
      : Promise.resolve([1, 0]);
  await assertRejects(
    () => buildEmbeddingIndex("a".repeat(256), ["content"], embed, "c"),
    Error,
    "exceeds",
  );
});

Deno.test("full-source hash detects edits after the old prefix boundary", async () => {
  const prefix = "same ".repeat(1800);
  assert((await sourceHash(prefix + "A")) !== (await sourceHash(prefix + "B")));
});
