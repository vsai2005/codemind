/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Standalone output is for the DOCKER image only (Render), where server.js is the
   * entrypoint. Vercel builds through its own output pipeline and does not want this
   * set, so the Dockerfile opts in with DOCKER_BUILD=1 rather than every build paying
   * for it. Keeping it conditional is what lets the same repo deploy to both.
   */
  ...(process.env.DOCKER_BUILD === "1" ? { output: "standalone" } : {}),

  experimental: {
    /**
     * Runs instrumentation.ts once at server startup, which is where environment
     * validation lives. Without this the hook is never called and a misconfigured
     * deployment boots successfully and fails at the first request that needs config.
     */
    instrumentationHook: true,

    /**
     * pdfkit must NOT be bundled by webpack.
     *
     * It loads Adobe Font Metric files (Helvetica.afm and friends) from disk at runtime
     * using paths relative to its own package. Bundling rewrites the module into
     * .next/server/vendor-chunks/ but does not carry the .afm data along, so every PDF
     * render died with:
     *   ENOENT: open '.next/server/vendor-chunks/data/Helvetica.afm'
     *
     * Marking it external leaves it in node_modules, where its data files still sit
     * beside it. Next's output tracing then copies the whole package into the
     * standalone build, so this works in Docker as well as in dev.
     *
     * pdf-parse has the same problem: at runtime it loads pdf.worker.mjs from disk,
     * relative to its own package — `node_modules/pdf-parse/dist/pdf-parse/cjs/`, its
     * OWN bundled copy, not the separate pdfjs-dist package (pdfjs-dist is a
     * build-time-only dependency of pdf-parse; esbuild inlines its JS into
     * pdf-parse's own dist file, so pdfjs-dist itself is never required on disk at
     * runtime — only confirmed by testing the actual traced module, not by reasoning
     * about it, because the error message is easy to misread as pointing at pdfjs-dist).
     *
     * The fix below is required on top of the external-package declaration above:
     * `serverComponentsExternalPackages` only stops WEBPACK from bundling pdf-parse
     * into a single-file server chunk, which is necessary but not sufficient. Next's
     * standalone build separately runs its own file tracer to decide which files
     * actually ship in `.next/standalone`, and that tracer has no static
     * `require("./pdf.worker.mjs")` to follow — pdf-parse resolves it via a runtime
     * path computation — so it silently drops the file. This worked in every local
     * check because `next dev` never traces output at all; it only broke once
     * deployed, running from `.next/standalone` (verified by building standalone
     * locally and running pdf-parse straight out of its traced node_modules).
     */
    serverComponentsExternalPackages: ["pdfkit", "pdf-parse"],
    outputFileTracingIncludes: {
      "/api/upload": ["./node_modules/pdf-parse/dist/**/*"],
    },
  },
};

module.exports = nextConfig;
