/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",

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
     * pdf-parse (via pdfjs-dist) has the same problem: it loads pdf.worker.mjs from
     * disk relative to its own package, and bundling strips that sibling file, failing
     * with "Setting up fake worker failed: Cannot find module './pdf.worker.mjs'".
     */
    serverComponentsExternalPackages: ["pdfkit", "pdf-parse", "pdfjs-dist"],
  },
};

module.exports = nextConfig;
