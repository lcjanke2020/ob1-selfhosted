// A complete fetch lifetime bounded by one deadline: connection, headers, and
// response consumption all run under the same AbortSignal. Deadline failures
// become BoundedFetchTimeoutError; every other fetch/handler error is rethrown
// unchanged so callers can preserve their existing taxonomy. The response
// handler keeps status/body interpretation local while timer ownership and
// cleanup stay centralized here.

import { MAX_TIMER_DELAY_MS } from "./runtime_config.ts";

export type FetchLike = typeof fetch;

export class BoundedFetchTimeoutError extends Error {
  override readonly name = "BoundedFetchTimeoutError";

  constructor(readonly timeoutMs: number, options?: ErrorOptions) {
    super(`request timed out after ${timeoutMs}ms`, options);
  }
}

export type BoundedFetchOptions = Readonly<{
  timeoutMs: number;
  init?: Omit<RequestInit, "signal">;
  fetchFn?: FetchLike;
}>;

export async function boundedFetch<T>(
  input: string | URL | Request,
  options: BoundedFetchOptions,
  handleResponse: (
    response: Response,
    signal: AbortSignal,
  ) => T | Promise<T>,
): Promise<T> {
  if (
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      "boundedFetch timeoutMs must be a positive timer-safe integer",
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await (options.fetchFn ?? fetch)(input, {
      ...options.init,
      signal: controller.signal,
    });
    return await handleResponse(response, controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new BoundedFetchTimeoutError(options.timeoutMs, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
