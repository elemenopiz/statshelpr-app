const path = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@vercel/sandbox"],
  // @statshelpr/solver-core is a workspace package shipped as raw TS source
  // (no build step) — tell Next to run it through the app's own compiler
  // instead of treating it as pre-built node_modules code.
  transpilePackages: ["@statshelpr/solver-core"],
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
};

module.exports = nextConfig;
