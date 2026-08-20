import {
  propagation,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIsolatedOtel,
  createIsolatedOtelRuntime,
} from "../src/isolated-runtime";
import { isOtelActive, setupOtel } from "../src/setup";
import { withSpan as withMainSpan } from "../src/with-span";

const ENDPOINT = "http://collector.internal:4318";
const BAGGAGE_HEADER = "x-test-isolated-baggage";
const BAGGAGE_KEY = "photon.project.id";
const BAGGAGE_VALUE = "pho_prj_test";
const TRACEPARENT_HEADER = "x-test-isolated-traceparent";
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/u;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u;
const MAIN_TRACEPARENT =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

interface PublicExportedSpan {
  readonly resource: {
    readonly attributes: Readonly<Record<string, unknown>>;
  };
}

const publicExportedSpans = vi.hoisted(() => [] as PublicExportedSpan[]);

vi.mock("@opentelemetry/exporter-trace-otlp-http", async () => {
  const { ExportResultCode } = await import("@opentelemetry/core");
  return {
    OTLPTraceExporter: class {
      export(
        spans: readonly PublicExportedSpan[],
        resultCallback: (result: { code: number }) => void
      ): void {
        publicExportedSpans.push(...spans);
        resultCallback({ code: ExportResultCode.SUCCESS });
      }

      shutdown(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
});

const traceparentParts = (headers: Headers): readonly string[] => {
  const value = headers.get(TRACEPARENT_HEADER);
  if (!value) {
    throw new Error("expected isolated trace header");
  }
  return value.split("-");
};

const createRuntime = (
  serviceName = "projects-service",
  baggageHeader?: string
) => {
  const spanExporter = new InMemorySpanExporter();
  const logExporter = new InMemoryLogRecordExporter();
  const runtime = createIsolatedOtelRuntime(
    {
      ...(baggageHeader === undefined ? {} : { baggageHeader }),
      endpoint: ENDPOINT,
      traceparentHeader: TRACEPARENT_HEADER,
    },
    resourceFromAttributes({ "service.name": serviceName }),
    {
      logRecordProcessors: [new SimpleLogRecordProcessor(logExporter)],
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    }
  );
  return { logExporter, runtime, spanExporter };
};

beforeEach(() => {
  publicExportedSpans.length = 0;
});

afterEach(async () => {
  if (isOtelActive()) {
    await setupOtel({ serviceName: "cleanup" }).shutdown();
  }
});

describe("createIsolatedOtel", () => {
  it("starts independently without activating the main runtime", async () => {
    const isolated = createIsolatedOtel({
      endpoint: ENDPOINT,
      serviceName: "projects-service",
      traceparentHeader: TRACEPARENT_HEADER,
    });
    expect(isOtelActive()).toBe(false);
    await isolated.shutdown();
  });

  it("does not replace or shut down the main runtime", async () => {
    const main = setupOtel({ serviceName: "main-service" });
    const isolated = createIsolatedOtel({
      endpoint: ENDPOINT,
      serviceName: "projects-service",
      traceparentHeader: TRACEPARENT_HEADER,
    });

    expect(isOtelActive()).toBe(true);
    await isolated.shutdown();
    expect(isOtelActive()).toBe(true);
    expect(setupOtel({ serviceName: "ignored" })).toBe(main);
  });

  it("returns a new independent runtime on every call", async () => {
    const first = createIsolatedOtel({
      endpoint: ENDPOINT,
      serviceName: "projects-service",
      traceparentHeader: TRACEPARENT_HEADER,
    });
    const second = createIsolatedOtel({
      endpoint: ENDPOINT,
      serviceName: "projects-service",
      traceparentHeader: TRACEPARENT_HEADER,
    });

    expect(second).not.toBe(first);
    await first.shutdown();
    await second.shutdown();
  });

  it("keeps the main and isolated active spans independent", async () => {
    setupOtel({ serviceName: "main-service" });
    const isolated = createRuntime();

    await withMainSpan("main", async () => {
      const mainSpanId = trace.getActiveSpan()?.spanContext().spanId;
      expect(mainSpanId).toMatch(SPAN_ID_PATTERN);

      await isolated.runtime.withSpan("isolated", () => {
        expect(trace.getActiveSpan()?.spanContext().spanId).toBe(mainSpanId);
        const headers = new Headers();
        isolated.runtime.propagation.inject(headers);
        expect(traceparentParts(headers)[2]).not.toBe(mainSpanId);
      });

      expect(trace.getActiveSpan()?.spanContext().spanId).toBe(mainSpanId);
    });

    await isolated.runtime.shutdown();
  });

  it.each([
    "",
    "not-a-url",
    "ftp://collector.internal",
  ])("rejects invalid endpoint %j", (endpoint) => {
    expect(() =>
      createIsolatedOtel({
        endpoint,
        serviceName: "projects-service",
        traceparentHeader: TRACEPARENT_HEADER,
      })
    ).toThrowError(TypeError);
  });

  it.each([
    "",
    "bad header\nname",
    "baggage",
    "Baggage",
    "traceparent",
    "TraceParent",
  ])("rejects invalid traceparent header %j", (traceparentHeader) => {
    expect(() =>
      createIsolatedOtel({
        endpoint: ENDPOINT,
        serviceName: "projects-service",
        traceparentHeader,
      })
    ).toThrowError(TypeError);
  });

  it.each([
    "",
    "bad header\nname",
    "baggage",
    "Baggage",
    "traceparent",
    "TraceParent",
    TRACEPARENT_HEADER,
    TRACEPARENT_HEADER.toUpperCase(),
  ])("rejects invalid baggage header %j", (baggageHeader) => {
    expect(() =>
      createIsolatedOtel({
        baggageHeader,
        endpoint: ENDPOINT,
        serviceName: "projects-service",
        traceparentHeader: TRACEPARENT_HEADER,
      })
    ).toThrowError(TypeError);
  });

  it("exports only the Resource supplied to the independent runtime", async () => {
    setupOtel({
      resourceAttributes: { "main.runtime": true },
      serviceName: "main-service",
    });
    const isolated = createIsolatedOtel({
      endpoint: ENDPOINT,
      serviceName: "isolated-service",
      serviceVersion: "1.2.3",
      traceparentHeader: TRACEPARENT_HEADER,
    });

    await isolated.withSpan("resource-check", () => undefined);
    await isolated.shutdown();

    expect(publicExportedSpans).toHaveLength(1);
    expect(publicExportedSpans[0]?.resource.attributes).toMatchObject({
      "service.name": "isolated-service",
      "service.version": "1.2.3",
    });
    expect(
      publicExportedSpans[0]?.resource.attributes["main.runtime"]
    ).toBeUndefined();
  });

  it("omits service.version and never reads DEPLOYMENT_ENV", async () => {
    const previousDeploymentEnv = process.env.DEPLOYMENT_ENV;
    process.env.DEPLOYMENT_ENV = "production";
    try {
      const isolated = createIsolatedOtel({
        endpoint: ENDPOINT,
        serviceName: "isolated-service",
        traceparentHeader: TRACEPARENT_HEADER,
      });

      await isolated.withSpan("resource-check", () => undefined);
      await isolated.shutdown();

      const attributes = publicExportedSpans[0]?.resource.attributes;
      expect(attributes?.["service.name"]).toBe("isolated-service");
      expect(attributes?.["service.version"]).toBeUndefined();
      expect(attributes?.["deployment.environment"]).toBeUndefined();
    } finally {
      if (previousDeploymentEnv === undefined) {
        delete process.env.DEPLOYMENT_ENV;
      } else {
        process.env.DEPLOYMENT_ENV = previousDeploymentEnv;
      }
    }
  });

  it("lets explicit resourceAttributes override the service identity", async () => {
    const isolated = createIsolatedOtel({
      endpoint: ENDPOINT,
      resourceAttributes: { "service.name": "explicit-service" },
      serviceName: "isolated-service",
      traceparentHeader: TRACEPARENT_HEADER,
    });

    await isolated.withSpan("resource-check", () => undefined);
    await isolated.shutdown();

    expect(publicExportedSpans[0]?.resource.attributes["service.name"]).toBe(
      "explicit-service"
    );
  });
});

describe("isolated runtime", () => {
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
      "isolated.http",
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
    const logger = runtime.createLogger("test.isolated-logger");

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
    expect(record?.instrumentationScope.name).toBe("test.isolated-logger");
    expect(record?.spanContext?.traceId).toMatch(TRACE_ID_PATTERN);
    expect(record?.spanContext?.spanId).toMatch(SPAN_ID_PATTERN);
    expect(record?.resource.attributes["service.name"]).toBe(
      "projects-service"
    );
    await runtime.shutdown();
  });

  it("marks thrown errors without recording details and rethrows the same error", async () => {
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
    expect(failure?.status.message).toBeUndefined();
    expect(failure?.events).toEqual([]);
    expect(failure?.attributes["error.type"]).toBeUndefined();
    expect(failure?.instrumentationScope.name).toBe("@photon-ai/otel");
    await runtime.shutdown();
  });

  it("records error details only when explicitly requested", async () => {
    const { runtime, spanExporter } = createRuntime();
    const error = new TypeError("generation failed");

    await runtime.withSpan("explicit-error", () => {
      runtime.recordError(error);
    });

    const [span] = spanExporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("TypeError");
    expect(span?.events).toHaveLength(1);
    const [event] = span?.events ?? [];
    expect(event?.name).toBe("exception");
    expect(event?.attributes?.["exception.type"]).toBe("TypeError");
    expect(event?.attributes?.["exception.message"]).toBe("generation failed");
    expect(event?.attributes?.["exception.stacktrace"]).toContain(
      "TypeError: generation failed"
    );
    await runtime.shutdown();
  });

  it("handles non-Error thrown and explicitly recorded values", async () => {
    const { runtime, spanExporter } = createRuntime();
    const thrown = { reason: "generation failed" };

    await expect(
      runtime.withSpan("non-error-throw", () => {
        throw thrown;
      })
    ).rejects.toBe(thrown);
    await runtime.withSpan("non-error-record", () => {
      runtime.recordError(503);
    });

    const thrownSpan = spanExporter
      .getFinishedSpans()
      .find((span) => span.name === "non-error-throw");
    expect(thrownSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(thrownSpan?.events).toEqual([]);
    expect(thrownSpan?.attributes["error.type"]).toBeUndefined();

    const recordedSpan = spanExporter
      .getFinishedSpans()
      .find((span) => span.name === "non-error-record");
    expect(recordedSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(recordedSpan?.attributes["error.type"]).toBe("number");
    expect(recordedSpan?.events).toHaveLength(1);
    expect(recordedSpan?.events[0]?.attributes?.["exception.message"]).toBe(
      "503"
    );
    await runtime.shutdown();
  });

  it("does not duplicate an explicitly recorded error when it is thrown", async () => {
    const { runtime, spanExporter } = createRuntime();
    const error = new Error("generation failed");

    await expect(
      runtime.withSpan("explicit-thrown-error", () => {
        runtime.recordError(error);
        throw error;
      })
    ).rejects.toBe(error);

    const [span] = spanExporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(
      span?.events.filter((event) => event.name === "exception")
    ).toHaveLength(1);
    await runtime.shutdown();
  });

  it("ignores recordError outside a local recording Span", async () => {
    const { runtime, spanExporter } = createRuntime();

    expect(() => runtime.recordError(new Error("ignored"))).not.toThrow();
    expect(spanExporter.getFinishedSpans()).toEqual([]);
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
    const runtime = createIsolatedOtelRuntime(
      { endpoint: ENDPOINT, traceparentHeader: TRACEPARENT_HEADER },
      resourceFromAttributes({ "service.name": "projects-service" }),
      {
        logRecordProcessors: [failingLogProcessor],
        spanProcessors: [failingSpanProcessor],
      }
    );
    const logger = runtime.createLogger("test.isolated-logger");
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
    const runtime = createIsolatedOtelRuntime(
      { endpoint: ENDPOINT, traceparentHeader: TRACEPARENT_HEADER },
      resourceFromAttributes({ "service.name": "projects-service" }),
      { spanProcessors: [failingSpanProcessor] }
    );

    await expect(runtime.shutdown()).rejects.toBe(shutdownError);
  });

  it("does not inject baggage when no private baggage carrier is configured", async () => {
    const { runtime } = createRuntime();
    const baggage = propagation.createBaggage({
      [BAGGAGE_KEY]: { value: BAGGAGE_VALUE },
    });
    const baggageContext = propagation.setBaggage(
      runtime.propagation.capture(),
      baggage
    );
    const outgoing = new Headers({ baggage: "main=value" });

    await runtime.propagation.run(baggageContext, () => {
      runtime.propagation.inject(outgoing);
    });

    expect(outgoing.has(BAGGAGE_HEADER)).toBe(false);
    expect(outgoing.get("baggage")).toBe("main=value");
    await runtime.shutdown();
  });

  it("round-trips native OTel baggage through a private carrier", async () => {
    const upstream = createRuntime("service-a", BAGGAGE_HEADER);
    const downstream = createRuntime("service-b", BAGGAGE_HEADER);
    const baggage = propagation.createBaggage({
      [BAGGAGE_KEY]: { value: BAGGAGE_VALUE },
    });
    const baggageContext = propagation.setBaggage(
      upstream.runtime.propagation.capture(),
      baggage
    );
    const requestHeaders = new Headers({ baggage: "main=value" });

    await upstream.runtime.propagation.run(baggageContext, () =>
      upstream.runtime.withSpan("service-a", () => {
        upstream.runtime.propagation.inject(requestHeaders);
      })
    );

    expect(requestHeaders.get(BAGGAGE_HEADER)).toBe(
      `${BAGGAGE_KEY}=${BAGGAGE_VALUE}`
    );
    expect(requestHeaders.get("baggage")).toBe("main=value");
    const extracted = downstream.runtime.propagation.extract(requestHeaders);
    if (!extracted) {
      throw new Error("expected extracted isolated context");
    }
    expect(
      propagation.getBaggage(extracted)?.getEntry(BAGGAGE_KEY)?.value
    ).toBe(BAGGAGE_VALUE);

    await downstream.runtime.propagation.run(extracted, async () => {
      await Promise.resolve();
      expect(
        propagation
          .getBaggage(downstream.runtime.propagation.capture())
          ?.getEntry(BAGGAGE_KEY)?.value
      ).toBe(BAGGAGE_VALUE);
    });

    await Promise.all([
      upstream.runtime.shutdown(),
      downstream.runtime.shutdown(),
    ]);
  });

  it("restores nested baggage scopes and captured snapshots without leaking runtimes", async () => {
    const first = createRuntime("service-a", BAGGAGE_HEADER);
    const second = createRuntime("service-b", BAGGAGE_HEADER);
    const outerContext = propagation.setBaggage(
      first.runtime.propagation.capture(),
      propagation.createBaggage({
        [BAGGAGE_KEY]: { value: "outer-project" },
      })
    );
    let snapshot = ROOT_CONTEXT;

    await first.runtime.propagation.run(outerContext, async () => {
      await Promise.resolve();
      snapshot = first.runtime.propagation.capture();
      expect(
        propagation.getBaggage(snapshot)?.getEntry(BAGGAGE_KEY)?.value
      ).toBe("outer-project");
      expect(
        propagation
          .getBaggage(second.runtime.propagation.capture())
          ?.getEntry(BAGGAGE_KEY)
      ).toBeUndefined();

      const innerContext = propagation.setBaggage(
        snapshot,
        propagation.createBaggage({
          [BAGGAGE_KEY]: { value: "inner-project" },
        })
      );
      await first.runtime.propagation.run(innerContext, async () => {
        await Promise.resolve();
        expect(
          propagation
            .getBaggage(first.runtime.propagation.capture())
            ?.getEntry(BAGGAGE_KEY)?.value
        ).toBe("inner-project");
      });
      expect(
        propagation
          .getBaggage(first.runtime.propagation.capture())
          ?.getEntry(BAGGAGE_KEY)?.value
      ).toBe("outer-project");
    });

    expect(
      propagation
        .getBaggage(first.runtime.propagation.capture())
        ?.getEntry(BAGGAGE_KEY)
    ).toBeUndefined();
    await first.runtime.propagation.run(snapshot, () => {
      expect(
        propagation
          .getBaggage(first.runtime.propagation.capture())
          ?.getEntry(BAGGAGE_KEY)?.value
      ).toBe("outer-project");
    });

    await Promise.all([first.runtime.shutdown(), second.runtime.shutdown()]);
  });

  it("extracts a baggage-only isolated Context", async () => {
    const { runtime } = createRuntime("service-b", BAGGAGE_HEADER);
    const extracted = runtime.propagation.extract(
      new Headers({
        [BAGGAGE_HEADER]: `${BAGGAGE_KEY}=${BAGGAGE_VALUE}`,
      })
    );

    expect(extracted).toBeDefined();
    expect(extracted && trace.getSpanContext(extracted)).toBeUndefined();
    expect(
      extracted &&
        propagation.getBaggage(extracted)?.getEntry(BAGGAGE_KEY)?.value
    ).toBe(BAGGAGE_VALUE);

    const outgoing = new Headers();
    if (extracted) {
      await runtime.propagation.run(extracted, () => {
        runtime.propagation.inject(outgoing);
      });
    }
    expect(outgoing.get(BAGGAGE_HEADER)).toBe(
      `${BAGGAGE_KEY}=${BAGGAGE_VALUE}`
    );
    expect(outgoing.has(TRACEPARENT_HEADER)).toBe(false);
    await runtime.shutdown();
  });

  it("extracts trace and baggage independently", async () => {
    const { runtime } = createRuntime("service-b", BAGGAGE_HEADER);
    const baggageWithInvalidTrace = runtime.propagation.extract(
      new Headers({
        [BAGGAGE_HEADER]: `${BAGGAGE_KEY}=${BAGGAGE_VALUE}`,
        [TRACEPARENT_HEADER]: "not-valid",
      })
    );
    expect(
      baggageWithInvalidTrace &&
        propagation.getBaggage(baggageWithInvalidTrace)?.getEntry(BAGGAGE_KEY)
          ?.value
    ).toBe(BAGGAGE_VALUE);

    const traceWithInvalidBaggage = runtime.propagation.extract(
      new Headers({
        [BAGGAGE_HEADER]: "not a valid member",
        [TRACEPARENT_HEADER]: MAIN_TRACEPARENT,
      })
    );
    expect(traceWithInvalidBaggage).toBeDefined();
    const extractedSpanContext = traceWithInvalidBaggage
      ? trace.getSpanContext(traceWithInvalidBaggage)
      : undefined;
    expect(
      extractedSpanContext && trace.isSpanContextValid(extractedSpanContext)
    ).toBe(true);
    expect(
      traceWithInvalidBaggage && propagation.getBaggage(traceWithInvalidBaggage)
    ).toBeUndefined();
    await runtime.shutdown();
  });

  it("removes spoofed private baggage and preserves standard baggage", async () => {
    const { runtime } = createRuntime("service-a", BAGGAGE_HEADER);
    const outgoing = new Headers({
      [BAGGAGE_HEADER]: `${BAGGAGE_KEY}=spoofed`,
      baggage: "main=value",
    });

    runtime.propagation.inject(outgoing);

    expect(outgoing.has(BAGGAGE_HEADER)).toBe(false);
    expect(outgoing.get("baggage")).toBe("main=value");
    await runtime.shutdown();
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
        throw new Error("expected extracted isolated context");
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
        throw new Error("expected middle isolated context");
      }

      await middle.runtime.propagation.run(middleContext, async () => {
        expect(middle.runtime.hasActiveSpan()).toBe(false);
        const downstreamHeaders = new Headers();
        middle.runtime.propagation.inject(downstreamHeaders);
        const downstreamContext =
          downstream.runtime.propagation.extract(downstreamHeaders);
        if (!downstreamContext) {
          throw new Error("expected downstream isolated context");
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

  it("propagates baggage through a middle service that records no Span", async () => {
    const upstream = createRuntime("service-a", BAGGAGE_HEADER);
    const middle = createRuntime("service-b", BAGGAGE_HEADER);
    const downstream = createRuntime("service-c", BAGGAGE_HEADER);
    const baggageContext = propagation.setBaggage(
      upstream.runtime.propagation.capture(),
      propagation.createBaggage({
        [BAGGAGE_KEY]: { value: BAGGAGE_VALUE },
      })
    );

    await upstream.runtime.propagation.run(baggageContext, () =>
      upstream.runtime.withSpan("service-a", async () => {
        const middleHeaders = new Headers();
        upstream.runtime.propagation.inject(middleHeaders);
        const middleContext = middle.runtime.propagation.extract(middleHeaders);
        if (!middleContext) {
          throw new Error("expected middle isolated context");
        }

        await middle.runtime.propagation.run(middleContext, () => {
          const downstreamHeaders = new Headers();
          middle.runtime.propagation.inject(downstreamHeaders);
          const downstreamContext =
            downstream.runtime.propagation.extract(downstreamHeaders);
          if (!downstreamContext) {
            throw new Error("expected downstream isolated context");
          }
          expect(
            propagation.getBaggage(downstreamContext)?.getEntry(BAGGAGE_KEY)
              ?.value
          ).toBe(BAGGAGE_VALUE);
        });
      })
    );

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
