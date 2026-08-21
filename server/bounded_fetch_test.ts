import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  boundedFetch,
  BoundedFetchTimeoutError,
  type FetchLike,
} from "./bounded_fetch.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("boundedFetch: covers response consumption and always clears its timer", async () => {
  let requestSignal: AbortSignal | null = null;
  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal ?? null;
    return Promise.resolve(new Response("complete"));
  }) as FetchLike;

  const value = await boundedFetch(
    "https://example.invalid",
    { timeoutMs: 20, fetchFn },
    (response) => response.text(),
  );
  assertEquals(value, "complete");
  await delay(35);
  assertEquals((requestSignal as unknown as AbortSignal).aborted, false);
});

Deno.test("boundedFetch: timeout before headers has a stable error type", async () => {
  const fetchFn =
    ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          {
            once: true,
          },
        );
      })) as FetchLike;

  const error = await assertRejects(
    () =>
      boundedFetch(
        "https://example.invalid",
        { timeoutMs: 10, fetchFn },
        (response) => response,
      ),
    BoundedFetchTimeoutError,
  );
  assertEquals(error.timeoutMs, 10);
});

Deno.test("boundedFetch: the same deadline covers a stalled body handler", async () => {
  const fetchFn = (() => Promise.resolve(new Response(null))) as FetchLike;
  const error = await assertRejects(
    () =>
      boundedFetch(
        "https://example.invalid",
        { timeoutMs: 10, fetchFn },
        (_response, signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    BoundedFetchTimeoutError,
  );
  assertEquals(error.timeoutMs, 10);
});

Deno.test("boundedFetch: non-timeout transport errors remain intact", async () => {
  const transportError = new TypeError("network unavailable");
  const fetchFn = (() => Promise.reject(transportError)) as FetchLike;
  const error = await assertRejects(
    () =>
      boundedFetch(
        "https://example.invalid",
        { timeoutMs: 100, fetchFn },
        (response) => response,
      ),
    TypeError,
  );
  assertStrictEquals(error, transportError);
});

Deno.test("boundedFetch: handler failures remain intact and clear the timer", async () => {
  let requestSignal: AbortSignal | null = null;
  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal ?? null;
    return Promise.resolve(new Response(null));
  }) as FetchLike;
  const handlerError = new Error("response contract failed");
  const error = await assertRejects(
    () =>
      boundedFetch(
        "https://example.invalid",
        { timeoutMs: 20, fetchFn },
        () => {
          throw handlerError;
        },
      ),
    Error,
  );
  assertStrictEquals(error, handlerError);
  await delay(35);
  assertEquals((requestSignal as unknown as AbortSignal).aborted, false);
});

Deno.test("boundedFetch: rejects unsafe deadlines without creating a timer", async () => {
  const error = await assertRejects(
    () =>
      boundedFetch(
        "https://example.invalid",
        { timeoutMs: 0 },
        (response) => response,
      ),
    RangeError,
  );
  assertInstanceOf(error, RangeError);
});
