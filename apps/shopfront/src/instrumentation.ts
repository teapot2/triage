import type { Instrumentation } from "next";

export async function register() {
  // The OTel Node SDK uses Node-only APIs; never load it in the edge runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}

// Errors the server catches on its own: a route handler or a page render
// that threw. Logged with the request they failed, since nothing else in
// the app sees them. Handled errors (a page that catches and shows a
// message) are logged where they're caught.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logger } = await import("./lib/logger");
  const error = err instanceof Error ? err : new Error(String(err));
  const digest = typeof err === "object" && err !== null && "digest" in err ? String(err.digest) : undefined;
  logger.error("request failed", {
    "http.request.method": request.method,
    "url.path": request.path,
    "http.route": context.routePath,
    "next.route_type": context.routeType,
    "error.type": error.name,
    "error.message": error.message,
    ...(digest ? { "error.digest": digest } : {}),
  });
};
