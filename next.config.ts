import type { NextConfig } from "next";

/**
 * `output: "standalone"` is for the Docker image: it emits a self-contained
 * server under .next/standalone.
 *
 * It must NOT be used on Vercel. Vercel runs its own output file tracing and
 * expects the default build layout, so a standalone build fails there with
 * `ENOENT: .next/next-server.js.nft.json` — the trace manifest standalone mode
 * relocates. `VERCEL` is set by Vercel's build environment, so the same repo
 * produces a standalone build for Docker and a normal one for Vercel.
 */
const nextConfig: NextConfig = {
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
