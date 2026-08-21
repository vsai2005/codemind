/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",

  experimental: {
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
     */
    serverComponentsExternalPackages: ["pdfkit"],
  },
};

module.exports = nextConfig;
