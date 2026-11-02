import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { accessLogProcessor } from "./lib/access-log";
import { flagStates } from "./lib/flags";
import { logger, minLevel } from "./lib/logger";

const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318").replace(/\/$/, "");
const version = process.env.npm_package_version ?? "0.1.0";
const environment = process.env.NODE_ENV ?? "development";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "shopfront",
    [ATTR_SERVICE_VERSION]: version,
    "deployment.environment.name": environment,
  }),
  spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }) }), accessLogProcessor()],
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 10_000,
    }),
  ],
  logRecordProcessors: [
    new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }) }),
  ],
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs/dns/net spans are noise for an app this size
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
    }),
  ],
});

sdk.start();

// The lines a server writes as it comes up: what's running, how it's
// configured, and the flags it started with.
logger.info("server: started", {
  "service.version": version,
  "deployment.environment": environment,
  "node.version": process.version,
  "process.pid": process.pid,
  "server.port": Number(process.env.PORT ?? 3001),
  "log.level": minLevel,
  "telemetry.endpoint": endpoint,
});
logger.info("flags: loaded", Object.fromEntries(flagStates().map((f) => [`flag.${f.name}`, f.enabled])));
// Loaded only now: the jobs open the database pool, and what the pool logs
// as it opens can only reach the SDK once it is running.
const { startJobs } = await import("./lib/jobs");
startJobs();

const shutdown = (signal: string) => {
  logger.info("server: shutting down", { "process.signal": signal });
  sdk.shutdown().catch((err) => console.error("otel shutdown failed", err));
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
