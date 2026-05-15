import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSpan } from "../src/with-span";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

describe("withSpan", () => {
  beforeEach(() => {
    exporter.reset();
  });

  it("wraps an async function and marks span OK", async () => {
    const result = await withSpan("async-op", async () => {
      await Promise.resolve();
      return 42;
    });
    expect(result).toBe(42);

    const [span] = exporter.getFinishedSpans();
    expect(span).toBeDefined();
    expect(span?.name).toBe("async-op");
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("wraps a sync function and marks span OK", async () => {
    const result = await withSpan("sync-op", () => "hello");
    expect(result).toBe("hello");

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("sync-op");
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("attaches attributes when provided", async () => {
    await withSpan("with-attrs", { key: "value", n: 5 }, () => undefined);

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes.key).toBe("value");
    expect(span?.attributes.n).toBe(5);
  });

  it("records exception and marks ERROR on throw", async () => {
    const err = new Error("boom");
    await expect(
      withSpan("failing", () => {
        throw err;
      })
    ).rejects.toBe(err);

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("Error");
    expect(span?.events.length).toBeGreaterThan(0);
  });

  it("sanitizes PII in error message on span status", async () => {
    await expect(
      withSpan("pii-failure", () => {
        throw new Error("failed for foo.bar@example.com");
      })
    ).rejects.toThrow();

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.message).toContain("fo***@e***.com");
    expect(span?.status.message).not.toContain("foo.bar@example.com");
  });
});
