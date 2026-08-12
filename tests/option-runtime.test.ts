import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { suppressTracing } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemoryLogRecordExporter,
  type LogRecordProcessor,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOptionOtelRuntime,
  setupOptionOtel,
} from "../src/option-runtime";
import { isOtelActive, setupOtel } from "../src/setup";
import { withSpan as withMainSpan } from "../src/with-span";

const ENDPOINT = "http://collector.internal:4318";
const TRACEPARENT_HEADER = "x-test-option-traceparent";
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/u;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u;
const MAIN_TRACEPARENT =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

const traceparentParts = (headers: Headers): readonly string[] => {
  const value = headers.get(TRACEPARENT_HEADER);
  if (!value) {
    throw new Error("expected option trace header");
  }
  return value.split("-");
};

const createRuntime = (serviceName = "projects-service") => {
  const spanExporter = new InMemorySpanExporter();
  const logExporter = new InMemoryLogRecordExporter();
  const runtime = createOptionOtelRuntime(
    { endpoint: ENDPOINT, traceparentHeader: TRACEPARENT_HEADER },
    resourceFromAttributes({ "service.name": serviceName }),
    {
      logRecordProcessors: [new SimpleLogRecordProcessor(logExporter)],
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    }
  );
  return { logExporter, runtime, spanExporter };
};

afterEach(async () => {
  if (isOtelActive()) {
    await setupOtel({ serviceName: "cleanup" }).shutdown();
  }
});

describe("setupOptionOtel", () => {
  it("starts independently without activating the main runtime", async () => {
    const option = setupOptionOtel({
      endpoint: ENDPOINT,
      traceparentHeader: TRACEPARENT_HEADER,
    });
    expect(isOtelActive()).toBe(false);
    await option.shutdown();
  });

  it("does not replace or shut down the main runtime", async () => {
    const main = setupOtel({ serviceName: "main-service" });
    const option = setupOptionOtel({
      endpoint: ENDPOINT,
      traceparentHeader: TRACEPARENT_HEADER,
    });

    expect(isOtelActive()).toBe(true);
    await option.shutdown();
    expect(isOtelActive()).toBe(true);
    expect(setupOtel({ serviceName: "ignored" })).toBe(main);
  });

  it("keeps the main and option active spans independent", async () => {
    setupOtel({ serviceName: "main-service" });
    const option = createRuntime();

    await withMainSpan("main", async () => {
      const mainSpanId = trace.getActiveSpan()?.spanContext().spanId;
      expect(mainSpanId).toMatch(SPAN_ID_PATTERN);

      await option.runtime.withSpan("option", () => {
        expect(trace.getActiveSpan()?.spanContext().spanId).toBe(mainSpanId);
        const headers = new Headers();
        option.runtime.propagation.inject(headers);
        expect(traceparentParts(headers)[2]).not.toBe(mainSpanId);
      });

      expect(trace.getActiveSpan()?.spanContext().spanId).toBe(mainSpanId);
    });

    await option.runtime.shutdown();
  });

  it.each([
    "",
    "not-a-url",
    "ftp://collector.internal",
  ])("rejects invalid endpoint %j", (endpoint) => {
    expect(() =>
      setupOptionOtel({ endpoint, traceparentHeader: TRACEPARENT_HEADER })
    ).toThrowError(TypeError);
  });

  it.each([
    "",
    "bad header\nname",
    "traceparent",
    "TraceParent",
  ])("rejects invalid traceparent header %j", (traceparentHeader) => {
    expect(() =>
      setupOptionOtel({ endpoint: ENDPOINT, traceparentHeader })
    ).toThrowError(TypeError);
  });

  it("uses an independent Resource", async () => {
    const option = setupOptionOtel({
      endpoint: ENDPOINT,
      resourceAttributes: {
        "service.name": "option-service",
        "service.version": "1.2.3",
      },
      traceparentHeader: TRACEPARENT_HEADER,
    });
    expect(isOtelActive()).toBe(false);
    await option.shutdown();
  });
});

describe("option runtime", () => {
  it("keeps nested spans in one isolated trace across await", async () => {
    const { runtime, spanExporter } = createRuntime();
    const observedHeaders: string[][] = [];

    await runtime.withSpan("root", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const rootHeaders = new Headers();
      runtime.propagation.inject(rootHeaders);
      observedHeaders.push([...traceparentParts(rootHeaders)]);

      await runtime.withSpan("child", async () => {
        await Promise.resolve();
        const childHeaders = new Headers();
        runtime.propagation.inject(childHeaders);
        observedHeaders.push([...traceparentParts(childHeaders)]);
      });
    });

    const [rootHeader, childHeader] = observedHeaders;
    expect(rootHeader?.[1]).toBe(childHeader?.[1]);
    expect(rootHeader?.[2]).not.toBe(childHeader?.[2]);

    const spans = spanExporter.getFinishedSpans();
    const root = spans.find((span) => span.name === "root");
    const child = spans.find((span) => span.name === "child");
    expect(root?.status.code).toBe(SpanStatusCode.UNSET);
    expect(child?.spanContext().traceId).toBe(root?.spanContext().traceId);
    expect(child?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    await runtime.shutdown();
  });

  it("keeps concurrent requests in separate traces", async () => {
    const { runtime } = createRuntime();
    const traceIds = await Promise.all(
      [1, 2].map((value) =>
        runtime.withSpan(`request-${value}`, async () => {
          await Promise.resolve();
          const headers = new Headers();
          runtime.propagation.inject(headers);
          return traceparentParts(headers)[1];
        })
      )
    );

    expect(traceIds[0]).toBeDefined();
    expect(traceIds[1]).toBeDefined();
    expect(traceIds[0]).not.toBe(traceIds[1]);
    await runtime.shutdown();
  });

  it("supports a private active SERVER root with full Span options", async () => {
    const { runtime, spanExporter } = createRuntime();
    let callbackSpanId = "";

    await runtime.withActiveSpan(
      "option.http",
      {
        attributes: { "photon.api_key.id": "pho_sk_test" },
        kind: SpanKind.SERVER,
        parentContext: ROOT_CONTEXT,
      },
      (span) => {
        callbackSpanId = span.spanContext().spanId;
        expect(runtime.hasActiveSpan()).toBe(true);
      }
    );

    const [server] = spanExporter.getFinishedSpans();
    expect(server?.kind).toBe(SpanKind.SERVER);
    expect(server?.parentSpanContext).toBeUndefined();
    expect(server?.attributes["photon.api_key.id"]).toBe("pho_sk_test");
    expect(callbackSpanId).toBe(server?.spanContext().spanId);
    await runtime.shutdown();
  });

  it("does not activate or export spans when tracing is suppressed", async () => {
    const { runtime, spanExporter } = createRuntime();
    let callbackRan = false;
    const headers = new Headers();

    await runtime.propagation.run(suppressTracing(ROOT_CONTEXT), () =>
      runtime.withSpan("suppressed", () => {
        callbackRan = true;
        expect(runtime.hasActiveSpan()).toBe(false);
        runtime.propagation.inject(headers);
      })
    );

    expect(callbackRan).toBe(true);
    expect(headers.has(TRACEPARENT_HEADER)).toBe(false);
    expect(spanExporter.getFinishedSpans()).toEqual([]);
    await runtime.shutdown();
  });

  it("associates logs with the active local span and inherited Resource", async () => {
    const { logExporter, runtime } = createRuntime("projects-service");
    const logger = runtime.createLogger("test.option-logger");

    await runtime.withSpan("report.generate", () => {
      logger.emit({
        attributes: { "app.entity.id": "entity-123" },
        body: "Starting report generation",
        eventName: "test.message",
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
      });
    });

    const [record] = logExporter.getFinishedLogRecords();
    expect(record?.body).toBe("Starting report generation");
    expect(record?.instrumentationScope.name).toBe("test.option-logger");
    expect(record?.spanContext?.traceId).toMatch(TRACE_ID_PATTERN);
    expect(record?.spanContext?.spanId).toMatch(SPAN_ID_PATTERN);
    expect(record?.resource.attributes["service.name"]).toBe(
      "projects-service"
    );
    await runtime.shutdown();
  });

  it("records errors, returns original values, and rethrows the same error", async () => {
    const { runtime, spanExporter } = createRuntime();
    const value = { ok: true };

    await expect(runtime.withSpan("success", () => value)).resolves.toBe(value);
    const error = new Error("generation failed");
    await expect(
      runtime.withSpan("failure", () => {
        throw error;
      })
    ).rejects.toBe(error);

    const success = spanExporter
      .getFinishedSpans()
      .find((span) => span.name === "success");
    const failure = spanExporter
      .getFinishedSpans()
      .find((span) => span.name === "failure");
    expect(success?.status.code).toBe(SpanStatusCode.UNSET);
    expect(failure?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failure?.events.some((event) => event.name === "exception")).toBe(
      true
    );
    expect(failure?.instrumentationScope.name).toBe(
      "@photon-ai/otel.option-runtime"
    );
    await runtime.shutdown();
  });

  it("keeps business execution fail-open when processors throw", async () => {
    const failingLogProcessor = {
      forceFlush: () => Promise.resolve(),
      onEmit: () => {
        throw new Error("log processor failed");
      },
      shutdown: () => Promise.resolve(),
    } satisfies LogRecordProcessor;
    const failingSpanProcessor = {
      forceFlush: () => Promise.resolve(),
      onEnd: () => {
        throw new Error("span processor failed");
      },
      onStart: () => undefined,
      shutdown: () => Promise.resolve(),
    } satisfies SpanProcessor;
    const runtime = createOptionOtelRuntime(
      { endpoint: ENDPOINT, traceparentHeader: TRACEPARENT_HEADER },
      resourceFromAttributes({ "service.name": "projects-service" }),
      {
        logRecordProcessors: [failingLogProcessor],
        spanProcessors: [failingSpanProcessor],
      }
    );
    const logger = runtime.createLogger("test.option-logger");
    const result = { ok: true };

    await expect(
      runtime.withSpan("fail-open", () => {
        logger.emit({ body: "still running" });
        return result;
      })
    ).resolves.toBe(result);
    await runtime.shutdown();
  });

  it("surfaces processor shutdown failures", async () => {
    const shutdownError = new Error("span processor shutdown failed");
    const failingSpanProcessor = {
      forceFlush: () => Promise.resolve(),
      onEnd: () => undefined,
      onStart: () => undefined,
      shutdown: () => Promise.reject(shutdownError),
    } satisfies SpanProcessor;
    const runtime = createOptionOtelRuntime(
      { endpoint: ENDPOINT, traceparentHeader: TRACEPARENT_HEADER },
      resourceFromAttributes({ "service.name": "projects-service" }),
      { spanProcessors: [failingSpanProcessor] }
    );

    await expect(runtime.shutdown()).rejects.toBe(shutdownError);
  });

  it("propagates between runtimes without creating an automatic server span", async () => {
    const upstream = createRuntime("service-a");
    const downstream = createRuntime("service-b");
    let upstreamSpanId = "";

    await upstream.runtime.withSpan("service-a", async () => {
      const requestHeaders = new Headers();
      upstream.runtime.propagation.inject(requestHeaders);
      const parts = traceparentParts(requestHeaders);
      upstreamSpanId = parts[2] ?? "";
      const extracted = downstream.runtime.propagation.extract(requestHeaders);
      if (!extracted) {
        throw new Error("expected extracted option context");
      }
      expect(downstream.runtime.hasActiveSpan()).toBe(false);
      await downstream.runtime.propagation.run(extracted, async () => {
        expect(downstream.runtime.hasActiveSpan()).toBe(false);
        await downstream.runtime.withSpan("service-b", () => undefined);
      });
    });

    const [downstreamSpan] = downstream.spanExporter.getFinishedSpans();
    expect(downstreamSpan?.parentSpanContext?.spanId).toBe(upstreamSpanId);
    expect(downstreamSpan?.resource.attributes["service.name"]).toBe(
      "service-b"
    );
    await Promise.all([
      upstream.runtime.shutdown(),
      downstream.runtime.shutdown(),
    ]);
  });

  it("propagates through a middle service that records no Span", async () => {
    const upstream = createRuntime("service-a");
    const middle = createRuntime("service-b");
    const downstream = createRuntime("service-c");
    let upstreamSpanId = "";

    await upstream.runtime.withSpan("service-a", async () => {
      const middleHeaders = new Headers();
      upstream.runtime.propagation.inject(middleHeaders);
      upstreamSpanId = traceparentParts(middleHeaders)[2] ?? "";
      const middleContext = middle.runtime.propagation.extract(middleHeaders);
      if (!middleContext) {
        throw new Error("expected middle option context");
      }

      await middle.runtime.propagation.run(middleContext, async () => {
        expect(middle.runtime.hasActiveSpan()).toBe(false);
        const downstreamHeaders = new Headers();
        middle.runtime.propagation.inject(downstreamHeaders);
        const downstreamContext =
          downstream.runtime.propagation.extract(downstreamHeaders);
        if (!downstreamContext) {
          throw new Error("expected downstream option context");
        }
        await downstream.runtime.propagation.run(downstreamContext, () =>
          downstream.runtime.withSpan("service-c", () => undefined)
        );
      });
    });

    expect(middle.spanExporter.getFinishedSpans()).toEqual([]);
    const [downstreamSpan] = downstream.spanExporter.getFinishedSpans();
    expect(downstreamSpan?.parentSpanContext?.spanId).toBe(upstreamSpanId);
    await Promise.all([
      upstream.runtime.shutdown(),
      middle.runtime.shutdown(),
      downstream.runtime.shutdown(),
    ]);
  });

  it("ignores invalid propagation and removes caller-provided headers", async () => {
    const { runtime } = createRuntime();
    const invalid = new Headers({ [TRACEPARENT_HEADER]: "not-valid" });
    expect(runtime.propagation.extract(invalid)).toBeUndefined();

    const outgoing = new Headers({
      [TRACEPARENT_HEADER]: "spoofed",
      traceparent: MAIN_TRACEPARENT,
    });
    runtime.propagation.inject(outgoing);
    expect(outgoing.has(TRACEPARENT_HEADER)).toBe(false);
    expect(outgoing.get("traceparent")).toBe(MAIN_TRACEPARENT);

    await runtime.withSpan("root", () => {
      runtime.propagation.inject(outgoing);
      expect(outgoing.get(TRACEPARENT_HEADER)).toMatch(TRACEPARENT_PATTERN);
      expect(outgoing.get("traceparent")).toBe(MAIN_TRACEPARENT);
    });
    await runtime.shutdown();
  });
});
