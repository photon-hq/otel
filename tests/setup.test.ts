import dc from "node:diagnostics_channel";
import { metrics } from "@opentelemetry/api";
import { MeterProvider as SdkMeterProvider } from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOtelActive, setupOtel } from "../src/setup";

const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_METRIC_EXPORT_TIMEOUT",
  "DEPLOYMENT_ENV",
  "LOG_LEVEL",
] as const;

// Fetch instrumentation has two strategies and only one touches
// globalThis.fetch: the wrap (Bun, or mode "global") swaps the global and tags
// it with this marker; the native undici path (Node's default) leaves the
// global untouched and instead subscribes to undici's diagnostics_channel.
// Asserting on/off requires checking BOTH — a globalThis.fetch-only check is a
// silent no-op on Node, where the native path never reassigns the global, so it
// would pass even if instrumentation were still active.
const FETCH_PATCH_MARKER = Symbol.for("@photon-ai/otel.fetch.original");
const UNDICI_CHANNEL = "undici:request:create";

function fetchInstrumentationActive(): boolean {
  const fetchFn = globalThis.fetch as unknown as Record<symbol, unknown>;
  const globalWrapped = Boolean(fetchFn[FETCH_PATCH_MARKER]);
  return globalWrapped || dc.hasSubscribers(UNDICI_CHANNEL);
}

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("setupOtel", () => {
  beforeEach(() => {
    clearEnv();
  });

  afterEach(async () => {
    if (isOtelActive()) {
      // setupOtel is idempotent, so this returns the active handle whose
      // shutdown() clears the module-level activeHandle.
      await setupOtel({ serviceName: "cleanup" }).shutdown();
    }
    metrics.disable();
    clearEnv();
  });

  it("flips isOtelActive after setup and clears it after shutdown", async () => {
    expect(isOtelActive()).toBe(false);
    const handle = setupOtel({ serviceName: "active-test" });
    expect(isOtelActive()).toBe(true);
    await handle.shutdown();
    expect(isOtelActive()).toBe(false);
  });

  it("is idempotent — second call returns the same handle", () => {
    const first = setupOtel({ serviceName: "test-svc" });
    const second = setupOtel({ serviceName: "different-svc" });
    expect(second).toBe(first);
  });

  it("lets logLevel override the deployment default but not LOG_LEVEL", async () => {
    vi.resetModules();
    process.env.DEPLOYMENT_ENV = "development";
    const otelModule = await import("../src/index");
    const handle = otelModule.setupOtel({
      serviceName: "log-level-precedence",
      logLevel: "warn",
    });
    try {
      expect(otelModule.getLogLevel()).toBe("warn");

      process.env.LOG_LEVEL = "error";
      expect(otelModule.getLogLevel()).toBe("error");
    } finally {
      await handle.shutdown();
    }
  });

  it("works with no endpoint configured (graceful no-op exporters)", () => {
    const handle = setupOtel({ serviceName: "no-endpoint" });
    expect(handle).toBeDefined();
    expect(handle.meterProvider).toBeInstanceOf(SdkMeterProvider);
    expect(
      handle.getMeter("no-endpoint").createCounter("test.counter")
    ).toBeDefined();
    expect(typeof handle.shutdown).toBe("function");
  });

  it("getMeter delegates to this setup's provider", () => {
    const handle = setupOtel({ serviceName: "meter-handle" });

    expect(handle.getMeter("orders", "1.0.0")).toBe(
      handle.meterProvider.getMeter("orders", "1.0.0")
    );
    expect(metrics.getMeterProvider()).toBe(handle.meterProvider);
  });

  it("accepts an endpoint, headers, and resource attributes", () => {
    const handle = setupOtel({
      serviceName: "with-endpoint",
      serviceVersion: "1.2.3",
      endpoint: "https://otel.example.com",
      headers: { Authorization: "Basic xyz" },
      resourceAttributes: { "custom.tag": "value" },
    });
    expect(handle).toBeDefined();
  });

  it("auto-instruments fetch when a traces endpoint is configured", async () => {
    const original = globalThis.fetch;
    try {
      const handle = setupOtel({
        serviceName: "fetch-on",
        endpoint: "https://otel.example.com",
      });
      // Bun wraps the global; Node (mode "auto") registers the native undici
      // instrumentation instead. The helper detects either strategy, so this
      // asserts fetch is genuinely instrumented on both runtimes.
      expect(fetchInstrumentationActive()).toBe(true);
      expect(handle).toBeDefined();
      await handle.shutdown();
      expect(fetchInstrumentationActive()).toBe(false);
      expect(globalThis.fetch).toBe(original);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("mode 'global' wraps globalThis.fetch on any runtime", async () => {
    const original = globalThis.fetch;
    try {
      const handle = setupOtel({
        serviceName: "fetch-global",
        endpoint: "https://otel.example.com",
        instrumentFetch: { mode: "global" },
      });
      expect(globalThis.fetch).not.toBe(original);
      await handle.shutdown();
      expect(globalThis.fetch).toBe(original);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not instrument fetch when no endpoint is configured", async () => {
    const original = globalThis.fetch;
    try {
      const handle = setupOtel({ serviceName: "fetch-off" });
      expect(fetchInstrumentationActive()).toBe(false);
      expect(globalThis.fetch).toBe(original);
      await handle.shutdown();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("respects instrumentFetch: false even when an endpoint is configured", async () => {
    const original = globalThis.fetch;
    try {
      const handle = setupOtel({
        serviceName: "fetch-opt-out",
        endpoint: "https://otel.example.com",
        instrumentFetch: false,
      });
      // Neither strategy may activate: no global wrap AND no native undici
      // subscription. The bare globalThis.fetch check below would pass on Node
      // even if the native path had registered, so this is the real assertion.
      expect(fetchInstrumentationActive()).toBe(false);
      expect(globalThis.fetch).toBe(original);
      await handle.shutdown();
      expect(globalThis.fetch).toBe(original);
    } finally {
      globalThis.fetch = original;
    }
  });
});
