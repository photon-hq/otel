import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger";
import {
  clearActiveProviders,
  resolveLogger,
  resolveTracer,
  setActiveProviders,
} from "../src/scope";
import { withSpan } from "../src/with-span";

function tracerProviderWith(
  exporter: InMemorySpanExporter
): BasicTracerProvider {
  return new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
}

function loggerProviderWith(
  exporter: InMemoryLogRecordExporter
): LoggerProvider {
  return new LoggerProvider({
    processors: [new SimpleLogRecordProcessor(exporter)],
  });
}

describe("scope (provider holder)", () => {
  afterEach(() => {
    clearActiveProviders();
  });

  it("resolveTracer routes spans to the held provider", () => {
    const spanExporter = new InMemorySpanExporter();
    setActiveProviders({
      tracerProvider: tracerProviderWith(spanExporter),
      loggerProvider: loggerProviderWith(new InMemoryLogRecordExporter()),
    });
    resolveTracer("test").startSpan("held").end();
    expect(spanExporter.getFinishedSpans().map((s) => s.name)).toContain(
      "held"
    );
  });

  it("resolveLogger routes records to the held provider", () => {
    const logExporter = new InMemoryLogRecordExporter();
    setActiveProviders({
      tracerProvider: tracerProviderWith(new InMemorySpanExporter()),
      loggerProvider: loggerProviderWith(logExporter),
    });
    resolveLogger("test").emit({ body: "held-log" });
    expect(logExporter.getFinishedLogRecords().map((r) => r.body)).toContain(
      "held-log"
    );
  });

  it("falls back to the global provider after clear (no held emission)", () => {
    const spanExporter = new InMemorySpanExporter();
    setActiveProviders({
      tracerProvider: tracerProviderWith(spanExporter),
      loggerProvider: loggerProviderWith(new InMemoryLogRecordExporter()),
    });
    clearActiveProviders();
    // Global is the default no-op provider in this isolated test process, so the
    // span goes nowhere — crucially, NOT into the previously-held exporter.
    resolveTracer("test").startSpan("after-clear").end();
    expect(spanExporter.getFinishedSpans()).toHaveLength(0);
  });

  it("reflects a provider swap on the next resolve (no stale cache)", () => {
    const a = new InMemorySpanExporter();
    const b = new InMemorySpanExporter();
    const loggerProvider = loggerProviderWith(new InMemoryLogRecordExporter());
    setActiveProviders({
      tracerProvider: tracerProviderWith(a),
      loggerProvider,
    });
    resolveTracer("test").startSpan("to-a").end();
    setActiveProviders({
      tracerProvider: tracerProviderWith(b),
      loggerProvider,
    });
    resolveTracer("test").startSpan("to-b").end();
    expect(a.getFinishedSpans().map((s) => s.name)).toEqual(["to-a"]);
    expect(b.getFinishedSpans().map((s) => s.name)).toEqual(["to-b"]);
  });

  it("withSpan nests and createLogger correlates through the held providers", async () => {
    // Nesting/correlation need an ambient context manager (set-if-absent in
    // scoped mode); register one for this test.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager());
    const spanExporter = new InMemorySpanExporter();
    const logExporter = new InMemoryLogRecordExporter();
    setActiveProviders({
      tracerProvider: tracerProviderWith(spanExporter),
      loggerProvider: loggerProviderWith(logExporter),
    });
    const log = createLogger("scoped");

    await withSpan("parent", async () => {
      await withSpan("child", () => {
        log.info("inside");
      });
    });

    const spans = spanExporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "parent");
    const child = spans.find((s) => s.name === "child");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    // Same trace id ⇒ the child was created inside the parent's active context.
    expect(child?.spanContext().traceId).toBe(parent?.spanContext().traceId);

    const record = logExporter
      .getFinishedLogRecords()
      .find((r) => r.body === "inside");
    expect(record?.spanContext?.traceId).toBe(child?.spanContext().traceId);

    context.disable();
  });
});
