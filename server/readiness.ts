// Readiness depends only on fulfillment vs rejection; callers may return a
// diagnostic value (pingDb returns boolean), which is intentionally ignored.
export type ReadinessPing = () => Promise<unknown>;
export type ReadinessFailureLogger = (
  dbTarget: string,
  error: unknown,
) => void;

const logReadinessFailure: ReadinessFailureLogger = (dbTarget, error) => {
  console.error(`[ready] DB ping failed (${dbTarget}):`, error);
};

export async function readinessResponse(
  ping: ReadinessPing,
  dbTarget: string,
  logFailure: ReadinessFailureLogger = logReadinessFailure,
): Promise<Response> {
  try {
    await ping();
    return Response.json({ ok: true, db: "connected" });
  } catch (error) {
    // The configured DB target and driver detail stay in the server log. The
    // fixed body prevents an unauthenticated caller from learning role names,
    // database names, or failure details from the driver error.
    logFailure(dbTarget, error);
    return Response.json(
      { ok: false, error: "database unavailable" },
      { status: 503 },
    );
  }
}
