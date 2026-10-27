import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Keep the dev-only indicator off the sidebar footer controls.
  devIndicators: { position: "bottom-right" },
  partialPrefetching: true,
};

export default nextConfig;
