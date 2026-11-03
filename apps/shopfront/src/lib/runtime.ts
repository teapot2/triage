import semver from "semver";

// The Node.js version the store runs on, and whether it meets the range the
// workspace declares in engines, for the health check.
const required = ">=22.13";

export function runtimeInfo() {
  const node = process.versions.node;
  return { node, required, supported: semver.satisfies(node, required) };
}
