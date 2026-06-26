import { context, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
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
import {
  type FetchInstrumentation,
  type InstrumentFetchOptions,
  instrumentFetch,
} from "./instrument-fetch";
import { type LogLevel, setLogLevel } from "./logger";

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
   * Auto-instrument outbound `globalThis.fetch` with CLIENT spans and W3C
   * trace-context propagation. On Bun this is the only fetch instrumentation
   * that works (diagnostics_channel-based instrumentations emit nothing on
   * Bun's native fetch); it works identically on Node.
   *
   * `true` enables with defaults; pass an object to filter URLs via `ignore`.
   * Defaults to enabled when a traces endpoint is configured. Pass `false` to
   * disable.
   */
  instrumentFetch?: boolean | InstrumentFetchOptions;
  /**
   * Minimum log level emitted by `createLogger()` (to both OTLP and console).
   * The `LOG_LEVEL` env var still takes precedence. Defaults to `debug` in
   * development and `info` otherwise.
   */
  logLevel?: LogLevel;
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
 * Normalize a URL to an `origin + path` key (trailing slash stripped) for exact
 * self-trace matching. Returns `undefined` for unparseable URLs.
 */
function otlpEndpointKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(TRAILING_SLASH, "")}`;
  } catch {
    return;
  }
}

function otlpEndpointKeysOf(
  tracesEndpoint: string | undefined,
  logsEndpoint: string | undefined
): string[] {
  const keys: string[] = [];
  for (const endpoint of [tracesEndpoint, logsEndpoint]) {
    if (!endpoint) {
      continue;
    }
    const key = otlpEndpointKey(endpoint);
    if (key) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Patch `globalThis.fetch` unless disabled. Defaults to on when a traces
 * pipeline is configured. Always excludes our own OTLP endpoints so the
 * exporter's traffic is never self-traced (matters on Node, where the OTLP
 * exporter can use fetch).
 */
function startFetchInstrumentation(
  option: boolean | InstrumentFetchOptions | undefined,
  hasTraces: boolean,
  tracesEndpoint: string | undefined,
  logsEndpoint: string | undefined
): FetchInstrumentation | undefined {
  const want = option ?? hasTraces;
  if (!want) {
    return;
  }
  const userOptions = typeof option === "object" ? option : undefined;
  const otlpEndpointKeys = otlpEndpointKeysOf(tracesEndpoint, logsEndpoint);
  return instrumentFetch({
    ignore: (url) => {
      const key = otlpEndpointKey(url);
      const isOtlpEndpoint =
        key !== undefined && otlpEndpointKeys.includes(key);
      return isOtlpEndpoint || (userOptions?.ignore?.(url) ?? false);
    },
  });
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

  if (options.logLevel) {
    setLogLevel(options.logLevel);
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
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    })
  );

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

  const fetchInstrumentation = startFetchInstrumentation(
    options.instrumentFetch,
    traceProcessors.length > 0,
    tracesEndpoint,
    logsEndpoint
  );

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
      fetchInstrumentation?.unpatch();
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
