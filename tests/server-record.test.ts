import { context, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FetchRequestRecord,
  FetchResponseRecord,
} from "../src/fetch-record-options";
import type { RecordCapture } from "../src/record-options";
import { clearActiveProviders, setActiveProviders } from "../src/scope";
import {
  createHttpServerRecorder,
  createRpcServerRecorder,
  flushServerRecords,
  type RpcRequestRecord,
  type RpcResponseRecord,
} from "../src/server-record";

interface Envelope<T> {
  capture?: RecordCapture;
  code?: string;
  error?: { name: string; message: string };
  operation: Record<string, string>;
  parserError?: string;
  payload?: T;
  recordId: string;
  requestId?: string;
}

let exporter: InMemoryLogRecordExporter;
let loggerProvider: LoggerProvider;
let tracerProvider: BasicTracerProvider;
let spans: InMemorySpanExporter;

const records = <T>(name: string): Envelope<T>[] =>
  exporter
    .getFinishedLogRecords()
    .filter((record) => record.eventName === name)
    .map((record) => record.body as unknown as Envelope<T>);

const rpcInput = () => ({
  service: "test.Directory",
  method: "ListLines",
  message: () => ({ limit: 2 }),
});

beforeEach(() => {
  exporter = new InMemoryLogRecordExporter();
  loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor(exporter)],
  });
  spans = new InMemorySpanExporter();
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spans)],
  });
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable()
  );
  setActiveProviders({ loggerProvider, tracerProvider });
});

afterEach(async () => {
  await flushServerRecords({ timeoutMs: 0 });
  await Promise.all([loggerProvider.shutdown(), tracerProvider.shutdown()]);
  clearActiveProviders();
  context.disable();
  trace.disable();
  logs.disable();
  vi.restoreAllMocks();
});

describe("HTTP server recording", () => {
  it("captures final response content without consuming the business bodies or writing to console", async () => {
    const consoleSpies = ["debug", "info", "warn", "error", "log"].map(
      (level) =>
        vi.spyOn(console, level as "debug").mockImplementation(() => undefined)
    );
    const record = createHttpServerRecorder({ record: { preset: "bounded" } });
    await tracerProvider
      .getTracer("http")
      .startActiveSpan("GET /lines", async (span) => {
        const request = new Request("https://cosmos.example/lines", {
          method: "POST",
          body: '{"limit":2}',
          headers: {
            authorization: "secret",
            "content-type": "application/json",
          },
        });
        const call = record(request, { requestId: "req-1" });
        expect(await request.text()).toBe('{"limit":2}');
        const response = Response.json(
          { code: "NOT_FOUND", lines: [] },
          {
            status: 404,
            headers: { "set-cookie": "secret", "x-request-id": "req-1" },
          }
        );
        call.response(response);
        expect(await response.json()).toEqual({ code: "NOT_FOUND", lines: [] });
        span.end();
        await call.done;
      });
    const request = records<FetchRequestRecord>(
      "photon.http.server.request"
    )[0];
    const response = records<FetchResponseRecord>(
      "photon.http.server.response"
    )[0];
    expect(response?.payload).toMatchObject({
      status: 404,
      body: { data: '{"code":"NOT_FOUND","lines":[]}', encoding: "utf8" },
      capture: { complete: true },
    });
    expect(request?.payload?.body?.data).toBe('{"limit":2}');
    expect(request?.payload?.headers.authorization).toBeUndefined();
    expect(response?.payload?.headers["set-cookie"]).toBeUndefined();
    expect(response?.requestId).toBe("req-1");
    expect(request?.recordId).toBe(response?.recordId);
    expect(
      exporter
        .getFinishedLogRecords()
        .every(
          (record) =>
            record.spanContext?.traceId ===
            spans.getFinishedSpans()[0]?.spanContext().traceId
        )
    ).toBe(true);
    expect(
      exporter
        .getFinishedLogRecords()
        .every((record) => record.severityText === "DEBUG")
    ).toBe(true);
    expect(spans.getFinishedSpans()).toHaveLength(1);
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("distinguishes a complete empty response from an unavailable consumed body", async () => {
    const record = createHttpServerRecorder({ record: { preset: "bounded" } });
    const empty = record(new Request("https://example.test/empty"));
    empty.response(new Response(null, { status: 204 }));
    const used = new Response("already consumed");
    await used.text();
    const consumed = record(new Request("https://example.test/used"));
    consumed.response(used);
    await Promise.all([empty.done, consumed.done]);
    const results = records<FetchResponseRecord>("photon.http.server.response");
    expect(
      results.find((item) => item.payload?.status === 204)?.capture
    ).toEqual({ complete: true, capturedBytes: 0 });
    expect(
      results.find((item) => item.payload?.status === 200)?.capture
    ).toMatchObject({ complete: false, reason: "unavailable_body" });
  });

  it("bounds a response capture while leaving the full response intact", async () => {
    const record = createHttpServerRecorder({
      record: { preset: "bounded", maxBodyBytes: 4 },
    });
    const call = record(new Request("https://example.test"));
    const response = new Response("abcdefgh");
    call.response(response);
    expect(await response.text()).toBe("abcdefgh");
    await call.done;
    expect(
      records<FetchResponseRecord>("photon.http.server.response")[0]
    ).toMatchObject({
      capture: { complete: false, capturedBytes: 4, reason: "size_limit" },
      payload: { body: { data: "abcd" } },
    });
  });

  it("redacts the URL in both the envelope and response fallback", async () => {
    const record = createHttpServerRecorder({
      record: { preset: "bounded" },
      redactUrl: () => "safe-url",
    });
    const call = record(new Request("https://example.test/?token=secret"));
    call.response(new Response("ok"));
    await call.done;
    expect(
      JSON.stringify(exporter.getFinishedLogRecords().map((item) => item.body))
    ).not.toContain("secret");
    expect(
      records<FetchResponseRecord>("photon.http.server.response")[0]?.payload
        ?.url
    ).toBe("safe-url");
  });

  it("records an exception without fabricating a response and ignores duplicate completion", async () => {
    const call = createHttpServerRecorder({ record: { preset: "bounded" } })(
      new Request("https://example.test")
    );
    const error = new Error("database unavailable");
    expect(() => call.error(error)).not.toThrow();
    call.response(new Response("late"));
    call.error(new Error("duplicate"));
    await call.done;
    expect(records("photon.http.server.error")).toHaveLength(1);
    expect(records("photon.http.server.error")[0]?.error?.message).toBe(
      error.message
    );
    expect(records("photon.http.server.response")).toHaveLength(0);
  });

  it("finalizes an aborted request without waiting for the application handler", async () => {
    const controller = new AbortController();
    const call = createHttpServerRecorder({ record: { preset: "bounded" } })(
      new Request("https://example.test", { signal: controller.signal })
    );
    controller.abort();
    await call.done;
    call.response(new Response("late"));
    expect(records("photon.http.server.error")[0]?.code).toBe("CANCELLED");
    expect(records("photon.http.server.response")).toHaveLength(0);
  });

  it("flushes an unfinished request as incomplete, not a successful response", async () => {
    const call = createHttpServerRecorder({ record: { preset: "bounded" } })(
      new Request("https://example.test")
    );
    await flushServerRecords({ timeoutMs: 0 });
    await call.done;
    call.response(new Response("late"));
    expect(records("photon.http.server.incomplete")[0]?.capture).toMatchObject({
      complete: false,
      reason: "shutdown",
    });
    expect(records("photon.http.server.response")).toHaveLength(0);
  });

  it("marks a timed-out stream without cancelling the application reader", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      })
    );
    const call = createHttpServerRecorder({
      record: { preset: "bounded", bodyTimeoutMs: 10 },
    })(new Request("https://example.test"));
    call.response(response);
    const reading = response.text();
    controller.enqueue(new TextEncoder().encode("first"));
    await call.done;
    controller.enqueue(new TextEncoder().encode("last"));
    controller.close();
    expect(await reading).toBe("firstlast");
    expect(
      records<FetchResponseRecord>("photon.http.server.response")[0]?.capture
    ).toMatchObject({ complete: false, reason: "timeout" });
  });
});

describe("RPC server recording", () => {
  it("does not block an RPC when logger acquisition fails and releases admission", async () => {
    const getLogger = vi.spyOn(loggerProvider, "getLogger");
    getLogger.mockImplementationOnce(() => {
      throw new Error("logger unavailable");
    });
    const record = createRpcServerRecorder({
      record: { preset: "bounded", maxConcurrentCaptures: 1 },
    });
    const serialize = vi.fn(() => ({ lines: [] }));
    const dropped = record({ ...rpcInput(), message: serialize });
    expect(() => dropped.response(serialize)).not.toThrow();
    await dropped.done;
    expect(serialize).not.toHaveBeenCalled();
    const next = record(rpcInput());
    next.response(serialize);
    await next.done;
    expect(
      records<RpcResponseRecord>("photon.rpc.server.response")[0]?.capture
        ?.complete
    ).toBe(true);
  });

  it("retains its original logger provider for delayed captures", async () => {
    const otherExporter = new InMemoryLogRecordExporter();
    const otherProvider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(otherExporter)],
    });
    const call = createRpcServerRecorder({ record: { preset: "bounded" } })(
      rpcInput()
    );
    setActiveProviders({ loggerProvider: otherProvider, tracerProvider });
    call.response(() => ({ lines: [] }));
    await call.done;
    expect(records("photon.rpc.server.response")).toHaveLength(1);
    expect(otherExporter.getFinishedLogRecords()).toHaveLength(0);
    await otherProvider.shutdown();
  });

  it("snapshots ProtoJSON supplied by the adapter and records RPC status and headers", async () => {
    const value = {
      lines: [
        {
          id: "line-1",
          version: "9223372036854775807",
          availability: "AVAILABLE",
        },
      ],
    };
    const call = createRpcServerRecorder({ record: { preset: "bounded" } })({
      ...rpcInput(),
      system: "grpc",
      requestId: "rpc-1",
    });
    call.response(() => value, {
      headers: new Headers({
        "content-type": "application/grpc",
        authorization: "secret",
      }),
    });
    value.lines.length = 0;
    await call.done;
    const response = records<RpcResponseRecord>(
      "photon.rpc.server.response"
    )[0];
    expect(JSON.parse(response?.payload?.body?.data ?? "null")).toEqual({
      lines: [
        {
          id: "line-1",
          version: "9223372036854775807",
          availability: "AVAILABLE",
        },
      ],
    });
    expect(response?.payload).toMatchObject({
      code: "OK",
      method: "ListLines",
      service: "test.Directory",
      system: "grpc",
    });
    expect(response?.payload?.headers.authorization).toBeUndefined();
    expect(response?.requestId).toBe("rpc-1");
    expect(
      records<RpcRequestRecord>("photon.rpc.server.request")[0]?.recordId
    ).toBe(response?.recordId);
  });

  it.each([
    undefined,
    1n,
    Number.NaN,
    new Date(),
    Promise.resolve({}),
  ])("marks an unsupported serializer result as incomplete: %s", async (value) => {
    const call = createRpcServerRecorder({ record: { preset: "bounded" } })(
      rpcInput()
    );
    expect(() => call.response(() => value)).not.toThrow();
    await call.done;
    expect(
      records<RpcResponseRecord>("photon.rpc.server.response")[0]?.capture
    ).toMatchObject({ complete: false, reason: "serialization_error" });
  });

  it("does not expose thrown serializer text or affect the handler result", async () => {
    const call = createRpcServerRecorder({ record: { preset: "bounded" } })(
      rpcInput()
    );
    call.response(() => {
      throw new Error("credential=private");
    });
    await call.done;
    expect(
      JSON.stringify(exporter.getFinishedLogRecords().map((item) => item.body))
    ).not.toContain("private");
    expect(
      records<RpcResponseRecord>("photon.rpc.server.response")[0]?.capture
        ?.reason
    ).toBe("serialization_error");
  });

  it("does not run serializers when capacity or metadata-only policy prevents capture", async () => {
    const serialize = vi.fn(() => ({ secret: "value" }));
    const record = createRpcServerRecorder({
      record: { preset: "bounded", maxConcurrentCaptures: 1 },
    });
    const first = record(rpcInput());
    const limited = record({ ...rpcInput(), message: serialize });
    limited.response(serialize);
    await limited.done;
    expect(serialize).not.toHaveBeenCalled();
    expect(
      records<RpcResponseRecord>("photon.rpc.server.response")[0]?.capture
        ?.reason
    ).toBe("capacity_limit");
    first.response(() => ({}));
    await first.done;
    const next = record({ ...rpcInput(), message: serialize });
    next.response(serialize);
    await next.done;
    expect(serialize).toHaveBeenCalledTimes(2);
    serialize.mockClear();
    const metadata = createRpcServerRecorder({
      record: { preset: "bounded", maxBodyBytes: 0 },
    })({ ...rpcInput(), message: serialize });
    metadata.response(serialize);
    await metadata.done;
    expect(serialize).not.toHaveBeenCalled();
    expect(
      records<RpcResponseRecord>("photon.rpc.server.response").at(-1)?.capture
        ?.reason
    ).toBe("size_limit");
  });

  it("records an RPC failure code independently of HTTP status", async () => {
    const call = createRpcServerRecorder({ record: { preset: "bounded" } })(
      rpcInput()
    );
    call.error(new Error("Line lookup unavailable"), "UNAVAILABLE");
    await call.done;
    expect(records("photon.rpc.server.error")[0]).toMatchObject({
      code: "UNAVAILABLE",
      error: { message: "Line lookup unavailable" },
    });
    expect(records("photon.rpc.server.response")).toHaveLength(0);
  });

  it("omits raw payloads when a redacting parser fails", async () => {
    const call = createRpcServerRecorder({
      record: {
        preset: "custom",
        headers: ["content-type"],
        onParserError: "omit",
        parseResponse: () => {
          throw new Error("secret body");
        },
      },
    })(rpcInput());
    call.response(() => ({ token: "secret body" }));
    await call.done;
    const response = records<RpcResponseRecord>(
      "photon.rpc.server.response"
    )[0];
    expect(response?.payload).toBeUndefined();
    expect(response?.parserError).toBe("parser_error");
    expect(JSON.stringify(response)).not.toContain("secret body");
  });

  it("interrupts a hanging parser during shutdown", async () => {
    const call = createRpcServerRecorder({
      record: {
        preset: "custom",
        parserTimeoutMs: Number.POSITIVE_INFINITY,
        onParserError: "omit",
        parseResponse: () => new Promise(() => undefined),
      },
    })(rpcInput());
    call.response(() => ({ lines: [] }));
    await flushServerRecords({ timeoutMs: 10 });
    await call.done;
    expect(
      records<RpcResponseRecord>("photon.rpc.server.response")[0]?.parserError
    ).toBe("parser_shutdown");
  });

  it("keeps concurrent RPCs correlated to their own captured span and request ID", async () => {
    const record = createRpcServerRecorder({ record: { preset: "bounded" } });
    await Promise.all(
      ["one", "two"].map((id) =>
        tracerProvider.getTracer("rpc").startActiveSpan(id, async (span) => {
          const call = record({
            ...rpcInput(),
            requestId: id,
            message: () => ({ id }),
          });
          await Promise.resolve();
          call.response(() => ({ id }));
          span.end();
          await call.done;
        })
      )
    );
    for (const entry of exporter.getFinishedLogRecords()) {
      const body = entry.body as unknown as Envelope<RpcResponseRecord>;
      const owner = spans
        .getFinishedSpans()
        .find((span) => span.name === body.requestId);
      expect(entry.spanContext?.spanId).toBe(owner?.spanContext().spanId);
      expect(JSON.parse(body.payload?.body?.data ?? "null")).toEqual({
        id: body.requestId,
      });
    }
  });

  it("honors explicit tracing context for adapters outside the active scope", async () => {
    const span = tracerProvider.getTracer("rpc").startSpan("rpc");
    const call = createRpcServerRecorder({ record: { preset: "bounded" } })({
      ...rpcInput(),
      context: trace.setSpan(context.active(), span),
    });
    call.response(() => ({}));
    span.end();
    await call.done;
    expect(
      exporter
        .getFinishedLogRecords()
        .every(
          (record) => record.spanContext?.spanId === span.spanContext().spanId
        )
    ).toBe(true);
  });
});
