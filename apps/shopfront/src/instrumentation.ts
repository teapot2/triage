export async function register() {
  // The OTel Node SDK uses Node-only APIs; never load it in the edge runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
