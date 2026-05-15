import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
