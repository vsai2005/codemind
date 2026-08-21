/**
 * Startup configuration check.
 *
 * Next calls `register()` once, before the server begins handling requests. Running
 * validation here means a misconfigured deployment fails at boot with a message that
 * names the problem, rather than at the first sign-in with a stack trace.
 *
 * Two guards keep it from firing where it would be wrong:
 *
 *   NEXT_RUNTIME === "edge"   the edge bundle has no access to server-only config
 *   NEXT_PHASE === build      `next build` needs no DATABASE_URL or AUTH_SECRET, and
 *                             must not fail on a machine that has neither
 *
 * The runtime check excludes edge rather than requiring "nodejs": the variable is not
 * reliably populated by the time `register()` runs, so a positive test silently skipped
 * validation altogether — which is exactly the failure this file exists to prevent.
 *
 * `validateEnv` reports variable names only, so nothing secret reaches the log.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { validateEnv } = await import("@/lib/env");
  const { logger } = await import("@/lib/logger");

  try {
    const { warnings } = validateEnv();
    for (const warning of warnings) logger.warn(warning);
    logger.info("Environment validated", { warnings: warnings.length });
  } catch (error) {
    // Re-thrown so the process exits instead of serving requests it cannot fulfil.
    logger.error("Startup aborted: invalid environment", {
      error: error instanceof Error ? error.message : "unknown",
    });
    throw error;
  }
}
