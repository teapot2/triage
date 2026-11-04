import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // No dev-only "N" badge over the page (it showed in every demo recording).
  // Build and runtime errors still surface in dev.
  devIndicators: false,
  partialPrefetching: true,
};

export default nextConfig;
