import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg must NOT be in serverExternalPackages — it needs to be bundled
  // into the Worker. The nodejs_compat flag provides the Node.js APIs
  // (net, tls, crypto) that pg requires.
  turbopack: {
    root: "/Users/edison/Projects/bupos/code",
  },
};

export default nextConfig;
