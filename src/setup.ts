import { context, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export interface SetupOtelOptions {
  /**
   * Default OTLP/HTTP base endpoint (e.g. `https://otel.example.com`). The
   * `/v1/traces` and `/v1/logs` paths are appended automatically. Standard
   * `OTEL_EXPORTER_OTLP_*` env vars always take precedence.
   */
  endpoint?: string;
  /**
   * Default OTLP headers (e.g. `{ Authorization: "Basic ..." }`). Merged with
   * any headers parsed from `OTEL_EXPORTER_OTLP_HEADERS`; env values win on
   * conflicts.
   */
  headers?: Record<string, string>;
  /**
   * Extra resource attributes attached to every span/log alongside
   * `service.name` / `service.version`.
   */
  resourceAttributes?: Record<string, string | number | boolean>;
  serviceName: string;
  serviceVersion?: string;
}

export interface OtelHandle {
  shutdown(): Promise<void>;
}

let activeHandle: OtelHandle | undefined;

const TRAILING_SLASH = /\/$/;

function parseEnvHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function resolveTracesEndpoint(base: string | undefined): string | undefined {
  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (traces) {
    return traces;
  }
  const generic = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? base;
  return generic
    ? `${generic.replace(TRAILING_SLASH, "")}/v1/traces`
    : undefined;
}

function resolveLogsEndpoint(base: string | undefined): string | undefined {
  const logsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (logsEndpoint) {
    return logsEndpoint;
  }
  const generic = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? base;
  return generic ? `${generic.replace(TRAILING_SLASH, "")}/v1/logs` : undefined;
}

/**
 * Boot an OTLP/HTTP-based OpenTelemetry pipeline (traces + logs).
 *
 * Idempotent: calling twice in the same process is a no-op on the second
 * call, so libraries can safely invoke this without clobbering an app-level
 * OTel setup that ran earlier.
 *
 * Standard `OTEL_EXPORTER_OTLP_*` env vars override the `endpoint` and
 * `headers` arguments — this matches the OpenTelemetry SDK config spec.
 */
export function setupOtel(options: SetupOtelOptions): OtelHandle {
  if (activeHandle) {
    return activeHandle;
  }

  const tracesEndpoint = resolveTracesEndpoint(options.endpoint);
  const logsEndpoint = resolveLogsEndpoint(options.endpoint);
  const mergedHeaders = {
    ...options.headers,
    ...parseEnvHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
  };
  const hasHeaders = Object.keys(mergedHeaders).length > 0;

  const resource = resourceFromAttributes({
    "service.name": options.serviceName,
    ...(options.serviceVersion
      ? { "service.version": options.serviceVersion }
      : {}),
    "deployment.environment": process.env.DEPLOYMENT_ENV ?? "development",
    ...options.resourceAttributes,
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager());

  const traceProcessors = tracesEndpoint
    ? [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: tracesEndpoint,
            headers: hasHeaders ? mergedHeaders : undefined,
          })
        ),
      ]
    : [];

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: traceProcessors,
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const logProcessors = logsEndpoint
    ? [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({
            url: logsEndpoint,
            headers: hasHeaders ? mergedHeaders : undefined,
          })
        ),
      ]
    : [];

  const loggerProvider = new LoggerProvider({
    resource,
    processors: logProcessors,
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  const handle: OtelHandle = {
    async shutdown() {
      await Promise.allSettled([
        tracerProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
      activeHandle = undefined;
    },
  };

  activeHandle = handle;
  return handle;
}

/**
 * Read-only accessor for tests / debug paths that need to know whether
 * `setupOtel` has already run in this process.
 */
export function isOtelActive(): boolean {
  return activeHandle !== undefined;
}
