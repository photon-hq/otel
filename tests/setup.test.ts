import dc from "node:diagnostics_channel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOtelActive, setupOtel } from "../src/setup";

const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_INSTRUMENT_FETCH",
  "DEPLOYMENT_ENV",
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

  it("works with no endpoint configured (graceful no-op exporters)", () => {
    const handle = setupOtel({ serviceName: "no-endpoint" });
    expect(handle).toBeDefined();
    expect(typeof handle.shutdown).toBe("function");
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

  it("OTEL_INSTRUMENT_FETCH=false disables fetch even with instrumentFetch: true", async () => {
    process.env.OTEL_INSTRUMENT_FETCH = "false";
    const original = globalThis.fetch;
    try {
      const handle = setupOtel({
        serviceName: "env-fetch-off",
        endpoint: "https://otel.example.com",
        instrumentFetch: true,
      });
      // Env wins over the code option: neither strategy may activate.
      expect(fetchInstrumentationActive()).toBe(false);
      expect(globalThis.fetch).toBe(original);
      await handle.shutdown();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("OTEL_INSTRUMENT_FETCH=true enables fetch even with instrumentFetch: false", async () => {
    process.env.OTEL_INSTRUMENT_FETCH = "true";
    const original = globalThis.fetch;
    try {
      const handle = setupOtel({
        serviceName: "env-fetch-on",
        endpoint: "https://otel.example.com",
        instrumentFetch: false,
      });
      // Env wins over the code option: instrumentation is active despite the
      // explicit opt-out.
      expect(fetchInstrumentationActive()).toBe(true);
      await handle.shutdown();
      expect(fetchInstrumentationActive()).toBe(false);
      expect(globalThis.fetch).toBe(original);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("ignores an unrecognized OTEL_INSTRUMENT_FETCH and honors the code option", async () => {
    process.env.OTEL_INSTRUMENT_FETCH = "maybe";
    const original = globalThis.fetch;
    try {
      const handle = setupOtel({
        serviceName: "env-fetch-bogus",
        endpoint: "https://otel.example.com",
        instrumentFetch: false,
      });
      // Unrecognized value -> parseBooleanEnv returns undefined -> the code
      // option (false) decides, so fetch stays disabled.
      expect(fetchInstrumentationActive()).toBe(false);
      expect(globalThis.fetch).toBe(original);
      await handle.shutdown();
    } finally {
      globalThis.fetch = original;
    }
  });
});
