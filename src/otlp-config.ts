import { parseKeyPairsIntoRecord } from "@opentelemetry/core";

export type OtlpSignal = "logs" | "metrics" | "traces";

export interface MetricReaderTiming {
  exportIntervalMillis: number;
  exportTimeoutMillis: number;
}

const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000;
const DEFAULT_METRIC_EXPORT_TIMEOUT_MS = 30_000;
const TRAILING_SLASH = /\/$/;

const SIGNAL_ENDPOINT_ENV = {
  logs: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  metrics: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  traces: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
} as const satisfies Record<OtlpSignal, keyof NodeJS.ProcessEnv>;

const SIGNAL_HEADERS_ENV = {
  logs: "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  metrics: "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  traces: "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
} as const satisfies Record<OtlpSignal, keyof NodeJS.ProcessEnv>;

const SIGNAL_PATH = {
  logs: "logs",
  metrics: "metrics",
  traces: "traces",
} as const satisfies Record<OtlpSignal, string>;

export function parseEnvHeaders(
  raw: string | undefined
): Record<string, string> {
  return parseKeyPairsIntoRecord(raw);
}

export function resolveOtlpEndpoint(
  signal: OtlpSignal,
  base: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const signalEndpoint = env[SIGNAL_ENDPOINT_ENV[signal]];
  if (signalEndpoint) {
    return signalEndpoint;
  }
  const genericEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? base;
  return genericEndpoint
    ? `${genericEndpoint.replace(TRAILING_SLASH, "")}/v1/${SIGNAL_PATH[signal]}`
    : undefined;
}

export function resolveOtlpHeaders(
  signal: OtlpSignal,
  defaults: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return {
    ...defaults,
    ...parseEnvHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseEnvHeaders(env[SIGNAL_HEADERS_ENV[signal]]),
  };
}

function positiveIntegerOrDefault(
  raw: string | undefined,
  fallback: number
): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function resolveMetricReaderTiming(
  env: NodeJS.ProcessEnv = process.env
): MetricReaderTiming {
  const exportIntervalMillis = positiveIntegerOrDefault(
    env.OTEL_METRIC_EXPORT_INTERVAL,
    DEFAULT_METRIC_EXPORT_INTERVAL_MS
  );
  const requestedTimeoutMillis = positiveIntegerOrDefault(
    env.OTEL_METRIC_EXPORT_TIMEOUT,
    DEFAULT_METRIC_EXPORT_TIMEOUT_MS
  );
  return {
    exportIntervalMillis,
    exportTimeoutMillis: Math.min(requestedTimeoutMillis, exportIntervalMillis),
  };
}
