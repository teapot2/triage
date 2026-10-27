import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OTel instrumentations patch modules via require/import hooks, so the SDK and
  // the instrumented libraries (pg) must be loaded from node_modules at runtime,
  // not bundled by Next.
  serverExternalPackages: [
    "@opentelemetry/sdk-node",
    "@opentelemetry/auto-instrumentations-node",
    "pg",
  ],
};

export default nextConfig;
