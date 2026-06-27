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
import { createInstrumentedFetch } from "../src/instrument-fetch";

const exporter = new InMemorySpanExporter();
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

interface CapturedRequest {
  headers: Record<string, string>;
  method: string;
  url: string;
}

let captured: CapturedRequest[] = [];
let realFetch: typeof fetch;

// A network-free stand-in for an SDK's base fetch: records what it was handed
// and returns a Response whose status comes from a `?status=` query param. A
// `network-error` URL throws, simulating a transport failure.
function makeFakeFetch(): typeof fetch {
  return ((input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    for (const [key, value] of req.headers.entries()) {
      headers[key] = value;
    }
    captured.push({ url: req.url, method: req.method, headers });
    if (req.url.includes("network-error")) {
      return Promise.reject(new TypeError("fetch failed"));
    }
    const status = Number(new URL(req.url).searchParams.get("status") ?? "200");
    return Promise.resolve(new Response("ok", { status }));
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

describe("createInstrumentedFetch", () => {
  beforeEach(() => {
    exporter.reset();
    captured = [];
  });

  // The "defaults to global" test reassigns the global; hard-reset after each.
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("does not modify globalThis.fetch", () => {
    const before = globalThis.fetch;
    const instrumented = createInstrumentedFetch(makeFakeFetch());

    expect(globalThis.fetch).toBe(before);
    expect(instrumented).not.toBe(before);
  });

  it("creates a CLIENT span with HTTP attributes when the returned fetch is called", async () => {
    const instrumented = createInstrumentedFetch(makeFakeFetch());
    const res = await instrumented(
      "https://api.example.com:8443/v1/things?status=200"
    );

    expect(res.status).toBe(200);
    const span = spanByName("GET");
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

  it("injects a W3C traceparent into the outgoing request", async () => {
    const instrumented = createInstrumentedFetch(makeFakeFetch());
    await instrumented("https://api.example.com/x?status=200");

    const span = spanByName("GET");
    const traceparent = captured[0]?.headers.traceparent;
    expect(traceparent).toMatch(TRACEPARENT);
    expect(traceparent).toContain(span?.spanContext().traceId ?? "");
  });

  it("skips instrumentation for ignored URLs", async () => {
    const instrumented = createInstrumentedFetch(makeFakeFetch(), {
      ignore: (url) => url.includes("skip-me"),
    });
    await instrumented("https://api.example.com/skip-me?status=200");

    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers.traceparent).toBeUndefined();
  });

  it("merges static attributes into every span", async () => {
    const instrumented = createInstrumentedFetch(makeFakeFetch(), {
      attributes: { "peer.service": "openai" },
    });
    await instrumented("https://api.example.com/x?status=200");

    const span = spanByName("GET");
    expect(span?.attributes["peer.service"]).toBe("openai");
    expect(span?.attributes["http.request.method"]).toBe("GET");
  });

  it("is idempotent — wrapping an instrumented fetch returns it unchanged", async () => {
    const once = createInstrumentedFetch(makeFakeFetch());
    const twice = createInstrumentedFetch(once);

    expect(twice).toBe(once);
    await twice("https://api.example.com/x?status=200");
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it("defaults to globalThis.fetch when no base is passed", async () => {
    globalThis.fetch = makeFakeFetch();
    const before = globalThis.fetch;
    const instrumented = createInstrumentedFetch();

    await instrumented("https://api.example.com/x?status=200");
    expect(spanByName("GET")).toBeDefined();
    // Only the returned fetch is instrumented — the global is left as-is.
    expect(globalThis.fetch).toBe(before);
  });

  it("marks 4xx responses as ERROR", async () => {
    const instrumented = createInstrumentedFetch(makeFakeFetch());
    await instrumented("https://api.example.com/x?status=404");

    const span = spanByName("GET");
    expect(span?.attributes["http.response.status_code"]).toBe(404);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("records the exception and rethrows on network error", async () => {
    const instrumented = createInstrumentedFetch(makeFakeFetch());
    await expect(
      instrumented("https://api.example.com/network-error")
    ).rejects.toThrow();

    const span = spanByName("GET");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("TypeError");
  });
});
