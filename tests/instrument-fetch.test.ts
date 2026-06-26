import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { instrumentFetch } from "../src/instrument-fetch";

const exporter = new InMemorySpanExporter();
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

interface CapturedRequest {
  body: string;
  headers: Record<string, string>;
  method: string;
  signalAborted: boolean;
  url: string;
}

let captured: CapturedRequest[] = [];
let realFetch: typeof fetch;

// A network-free stand-in for fetch. Records what it was handed (so we can
// assert on injected headers / preserved body+signal) and returns a Response
// whose status is taken from a `?status=` query param. A `network-error` URL
// throws, simulating a transport failure.
function makeFakeFetch(): typeof fetch {
  return (async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    for (const [key, value] of req.headers.entries()) {
      headers[key] = value;
    }
    const body = req.body && !req.bodyUsed ? await req.text() : "";
    captured.push({
      url: req.url,
      method: req.method,
      headers,
      body,
      signalAborted: req.signal?.aborted ?? false,
    });
    if (req.url.includes("network-error")) {
      throw new TypeError("fetch failed");
    }
    const status = Number(new URL(req.url).searchParams.get("status") ?? "200");
    return new Response("ok", { status });
  }) as typeof fetch;
}

function spanByName(name: string): ReadableSpan | undefined {
  return exporter.getFinishedSpans().find((span) => span.name === name);
}

beforeAll(() => {
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
  );
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator()] })
  );
  realFetch = globalThis.fetch;
});

describe("instrumentFetch", () => {
  beforeEach(() => {
    exporter.reset();
    captured = [];
    globalThis.fetch = makeFakeFetch();
  });

  // Hard-reset so a patched global never leaks into other tests/files.
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("creates a CLIENT span with HTTP attributes", async () => {
    instrumentFetch();
    const res = await fetch(
      "https://api.example.com:8443/v1/things?status=200"
    );

    expect(res.status).toBe(200);
    const span = spanByName("GET");
    expect(span).toBeDefined();
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.attributes["http.request.method"]).toBe("GET");
    expect(span?.attributes["url.full"]).toBe(
      "https://api.example.com:8443/v1/things?status=200"
    );
    expect(span?.attributes["server.address"]).toBe("api.example.com");
    expect(span?.attributes["server.port"]).toBe(8443);
    expect(span?.attributes["http.response.status_code"]).toBe(200);
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("uses the uppercased HTTP method as the span name", async () => {
    instrumentFetch();
    await fetch("https://api.example.com/x?status=200", { method: "post" });

    const span = spanByName("POST");
    expect(span).toBeDefined();
    expect(span?.attributes["http.request.method"]).toBe("POST");
  });

  it("marks 4xx responses as ERROR", async () => {
    instrumentFetch();
    await fetch("https://api.example.com/x?status=404");

    const span = spanByName("GET");
    expect(span?.attributes["http.response.status_code"]).toBe(404);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("marks 5xx responses as ERROR", async () => {
    instrumentFetch();
    await fetch("https://api.example.com/x?status=503");

    const span = spanByName("GET");
    expect(span?.attributes["http.response.status_code"]).toBe(503);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("records the exception and rethrows on network error", async () => {
    instrumentFetch();
    await expect(
      fetch("https://api.example.com/network-error")
    ).rejects.toThrow();

    const span = spanByName("GET");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("TypeError");
    expect(span?.events.length).toBeGreaterThan(0);
  });

  it("sanitizes PII in the error message", async () => {
    globalThis.fetch = (() =>
      Promise.reject(
        new Error("failed for foo.bar@example.com")
      )) as typeof fetch;
    instrumentFetch();

    await expect(fetch("https://api.example.com/x")).rejects.toThrow();

    const span = spanByName("GET");
    expect(span?.status.message).toContain("fo***@e***.com");
    expect(span?.status.message).not.toContain("foo.bar@example.com");
  });

  it("nests the fetch span under the active span", async () => {
    instrumentFetch();
    const tracer = trace.getTracer("test");
    let outerTraceId = "";
    let outerSpanId = "";

    await tracer.startActiveSpan("outer", async (outer) => {
      outerTraceId = outer.spanContext().traceId;
      outerSpanId = outer.spanContext().spanId;
      await fetch("https://api.example.com/x?status=200");
      outer.end();
    });

    const span = spanByName("GET");
    expect(span?.parentSpanContext?.spanId).toBe(outerSpanId);
    expect(span?.spanContext().traceId).toBe(outerTraceId);
  });

  it("injects a W3C traceparent into the outgoing request", async () => {
    instrumentFetch();
    await fetch("https://api.example.com/x?status=200");

    const span = spanByName("GET");
    const traceparent = captured[0]?.headers.traceparent;
    expect(traceparent).toMatch(TRACEPARENT);
    expect(traceparent).toContain(span?.spanContext().traceId ?? "");
  });

  it("preserves method, body, and signal on string input", async () => {
    instrumentFetch();
    await fetch("https://api.example.com/x?status=200", {
      method: "POST",
      body: "payload",
      signal: AbortSignal.abort(),
    });

    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.body).toBe("payload");
    expect(captured[0]?.signalAborted).toBe(true);
  });

  it("keeps existing headers and adds traceparent for Request input", async () => {
    instrumentFetch();
    await fetch(
      new Request("https://api.example.com/x?status=200", {
        headers: { "x-custom": "1" },
      })
    );

    expect(captured[0]?.headers["x-custom"]).toBe("1");
    expect(captured[0]?.headers.traceparent).toMatch(TRACEPARENT);
  });

  it("skips instrumentation for ignored URLs", async () => {
    instrumentFetch({ ignore: (url) => url.includes("skip-me") });
    await fetch("https://api.example.com/skip-me?status=200");

    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers.traceparent).toBeUndefined();
  });

  it("does not double-wrap on repeated calls", async () => {
    instrumentFetch();
    const afterFirst = globalThis.fetch;
    instrumentFetch();

    expect(globalThis.fetch).toBe(afterFirst);
    await fetch("https://api.example.com/x?status=200");
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it("restores the original fetch on unpatch", () => {
    const fake = globalThis.fetch;
    const instrumentation = instrumentFetch();
    expect(globalThis.fetch).not.toBe(fake);

    instrumentation.unpatch();
    expect(globalThis.fetch).toBe(fake);
  });

  it("still emits a span when the Request body was already used", async () => {
    instrumentFetch();
    const req = new Request("https://api.example.com/x?status=200", {
      method: "POST",
      body: "used",
    });
    await req.text(); // consume the body -> bodyUsed === true

    await fetch(req);

    const span = spanByName("POST");
    expect(span).toBeDefined();
    expect(span?.attributes["http.response.status_code"]).toBe(200);
  });
});
