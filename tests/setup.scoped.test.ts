import dc from "node:diagnostics_channel";
import {
  context,
  ProxyTracerProvider,
  propagation,
  trace,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, describe, expect, it } from "vitest";
import { isOtelActive, setupOtel } from "../src/setup";

const ENDPOINT = "https://otel.example.com";
const FETCH_PATCH_MARKER = Symbol.for("@photon-ai/otel.fetch.original");
const UNDICI_CHANNEL = "undici:request:create";

function fetchInstrumentationActive(): boolean {
  const fetchFn = globalThis.fetch as unknown as Record<symbol, unknown>;
  return (
    Boolean(fetchFn[FETCH_PATCH_MARKER]) || dc.hasSubscribers(UNDICI_CHANNEL)
  );
}

describe("setupOtel scoped mode", () => {
  afterEach(async () => {
    if (isOtelActive()) {
      await setupOtel({ serviceName: "cleanup" }).shutdown();
    }
    // Reset the global OTel API so each test starts from a clean registry and
    // can assert global identity independently.
    trace.disable();
    logs.disable();
    context.disable();
    propagation.disable();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it("register: false leaves the global tracer/logger providers untouched", async () => {
    const beforeLogger = logs.getLoggerProvider();
    const handle = setupOtel({
      serviceName: "scoped",
      endpoint: ENDPOINT,
      register: false,
    });
    try {
      // The global tracer proxy does NOT delegate to the library's provider...
      const globalTracer = trace.getTracerProvider();
      if (globalTracer instanceof ProxyTracerProvider) {
        expect(globalTracer.getDelegate()).not.toBe(handle.tracerProvider);
      }
      // ...and the global logger provider is still the pre-setup no-op.
      expect(logs.getLoggerProvider()).toBe(beforeLogger);
      // The handle exposes the library's own (distinct) providers.
      expect(handle.tracerProvider).toBeDefined();
      expect(handle.loggerProvider).toBeDefined();
      expect(handle.loggerProvider).not.toBe(beforeLogger);
    } finally {
      await handle.shutdown();
    }
  });

  it("default mode registers the handle's providers globally", async () => {
    const handle = setupOtel({ serviceName: "global", endpoint: ENDPOINT });
    try {
      // The global tracer proxy delegates to the handle's provider.
      const globalTracer = trace.getTracerProvider();
      expect(globalTracer).toBeInstanceOf(ProxyTracerProvider);
      if (globalTracer instanceof ProxyTracerProvider) {
        expect(globalTracer.getDelegate()).toBe(handle.tracerProvider);
      }
      expect(logs.getLoggerProvider()).toBe(handle.loggerProvider);
    } finally {
      await handle.shutdown();
    }
  });

  it("scoped mode defaults fetch instrumentation off even with an endpoint", async () => {
    const original = globalThis.fetch;
    const handle = setupOtel({
      serviceName: "scoped-fetch",
      endpoint: ENDPOINT,
      register: false,
    });
    try {
      expect(fetchInstrumentationActive()).toBe(false);
      expect(globalThis.fetch).toBe(original);
    } finally {
      await handle.shutdown();
      globalThis.fetch = original;
    }
  });

  it("scoped mode + explicit instrumentFetch uses the global wrap, never native", async () => {
    const original = globalThis.fetch;
    const handle = setupOtel({
      serviceName: "scoped-fetch-on",
      endpoint: ENDPOINT,
      register: false,
      instrumentFetch: true,
    });
    try {
      // The wrap is used (global fetch swapped)...
      expect(globalThis.fetch).not.toBe(original);
      // ...and the native undici path is never registered (it can't target the
      // library's held provider).
      expect(dc.hasSubscribers(UNDICI_CHANNEL)).toBe(false);
    } finally {
      await handle.shutdown();
      globalThis.fetch = original;
    }
  });
});
