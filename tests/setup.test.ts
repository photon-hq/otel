import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IS_BUN } from "../src/runtime";
import { isOtelActive, setupOtel } from "../src/setup";

const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "DEPLOYMENT_ENV",
] as const;

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
      // Bun can only instrument fetch by wrapping the global. Node (mode
      // "auto") uses the native undici instrumentation, which leaves
      // globalThis.fetch untouched. Either way, shutdown restores the original.
      if (IS_BUN) {
        expect(globalThis.fetch).not.toBe(original);
      }
      expect(handle).toBeDefined();
      await handle.shutdown();
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
      expect(globalThis.fetch).toBe(original);
      await handle.shutdown();
      expect(globalThis.fetch).toBe(original);
    } finally {
      globalThis.fetch = original;
    }
  });
});
