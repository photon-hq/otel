import { describe, expect, it } from "vitest";
import {
  parseEnvHeaders,
  resolveMetricReaderTiming,
  resolveOtlpEndpoint,
  resolveOtlpHeaders,
} from "../src/otlp-config";

describe("OTLP configuration", () => {
  it("derives each signal path from the generic endpoint", () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com/" };

    expect(resolveOtlpEndpoint("traces", undefined, env)).toBe(
      "https://otel.example.com/v1/traces"
    );
    expect(resolveOtlpEndpoint("logs", undefined, env)).toBe(
      "https://otel.example.com/v1/logs"
    );
    expect(resolveOtlpEndpoint("metrics", undefined, env)).toBe(
      "https://otel.example.com/v1/metrics"
    );
  });

  it("uses signal-specific endpoints exactly as provided", () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://generic.example.com",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
        "https://metrics.example.com/custom/path/",
    };

    expect(
      resolveOtlpEndpoint("metrics", "https://code.example.com", env)
    ).toBe("https://metrics.example.com/custom/path/");
    expect(resolveOtlpEndpoint("logs", "https://code.example.com", env)).toBe(
      "https://generic.example.com/v1/logs"
    );
  });

  it("uses the code endpoint only when environment endpoints are absent", () => {
    expect(
      resolveOtlpEndpoint("metrics", "https://code.example.com/", {})
    ).toBe("https://code.example.com/v1/metrics");
    expect(resolveOtlpEndpoint("metrics", undefined, {})).toBeUndefined();
  });

  it("uses the code endpoint when the generic environment endpoint is empty", () => {
    expect(
      resolveOtlpEndpoint("metrics", "https://code.example.com", {
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
      })
    ).toBe("https://code.example.com/v1/metrics");
  });

  it("applies code, generic environment, then signal header precedence", () => {
    const headers = resolveOtlpHeaders(
      "metrics",
      { Authorization: "code", "x-code": "yes" },
      {
        OTEL_EXPORTER_OTLP_HEADERS:
          "Authorization=generic,x-generic=yes,shared=generic",
        OTEL_EXPORTER_OTLP_METRICS_HEADERS:
          "Authorization=metrics,shared=metrics,x-metrics=yes",
      }
    );

    expect(headers).toEqual({
      Authorization: "metrics",
      shared: "metrics",
      "x-code": "yes",
      "x-generic": "yes",
      "x-metrics": "yes",
    });
  });

  it("decodes headers and ignores malformed pairs", () => {
    expect(
      parseEnvHeaders("bad, =empty,token=a%3Db%3Dc, ok = hello%20there ")
    ).toEqual({
      ok: "hello there",
      token: "a=b=c",
    });
  });

  it("uses standard metric reader timing defaults", () => {
    expect(resolveMetricReaderTiming({})).toEqual({
      exportIntervalMillis: 60_000,
      exportTimeoutMillis: 30_000,
    });
  });

  it("accepts positive timing values and caps timeout at interval", () => {
    expect(
      resolveMetricReaderTiming({
        OTEL_METRIC_EXPORT_INTERVAL: "5000",
        OTEL_METRIC_EXPORT_TIMEOUT: "9000",
      })
    ).toEqual({
      exportIntervalMillis: 5000,
      exportTimeoutMillis: 5000,
    });
  });

  it("falls back for invalid timing values", () => {
    expect(
      resolveMetricReaderTiming({
        OTEL_METRIC_EXPORT_INTERVAL: "0",
        OTEL_METRIC_EXPORT_TIMEOUT: "not-a-number",
      })
    ).toEqual({
      exportIntervalMillis: 60_000,
      exportTimeoutMillis: 30_000,
    });
  });
});
