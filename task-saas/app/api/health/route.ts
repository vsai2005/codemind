import { NextResponse } from "next/server";

/**
 * Liveness probe for the hosting platform (Render's health check).
 *
 * Deliberately a LIVENESS check, not a readiness check: it reports only that the
 * process is up and serving, and does not touch the database.
 *
 * A health check that queries PostgreSQL sounds more thorough but behaves worse. Render
 * restarts an instance that fails its health check, and restarting the app does nothing
 * to fix a database outage — it just removes the instance that would have recovered on
 * its own once the database came back, and can turn a brief blip into a restart loop.
 * Database reachability is already surfaced where it belongs: requests fail with a 500
 * and the error is logged.
 *
 * Unauthenticated by design — the platform has no session. middleware.ts excludes
 * /api from its matcher, so nothing gates this route.
 *
 * The response body is a fixed literal. It carries no version, build id, environment
 * name, dependency status or configuration, because this endpoint is reachable by
 * anyone who can reach the app.
 */
/**
 * Forced dynamic. Without this Next prerenders the route to a static file at build
 * time, which is exactly wrong for a liveness probe: the reply would be served from
 * a build artifact rather than proving the running process answered, and the
 * no-store header below would not be applied the way it is here.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return NextResponse.json(
    { ok: true },
    {
      // Never cached: a cached 200 would keep reporting healthy after the instance died.
      headers: { "Cache-Control": "no-store" },
    }
  );
}
