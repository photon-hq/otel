import { Buffer } from "node:buffer";
import { context, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { flushFetchRecords } from "../src/fetch-record";
import {
  type FetchRecordCapture,
  type FetchRecordOptions,
  type FetchRequestRecord,
  type FetchResponseRecord,
  resolveFetchRecordOptions,
} from "../src/fetch-record-options";
import { createInstrumentedFetch } from "../src/instrument-fetch";
import { sanitizeUrl } from "../src/sanitize";
import { clearActiveProviders, setActiveProviders } from "../src/scope";

interface Envelope<T> {
  capture: FetchRecordCapture;
  parserError?: string;
  payload?: T;
}

const realFetch = globalThis.fetch;
let logExporter: InMemoryLogRecordExporter;
let spanExporter: InMemorySpanExporter;
let loggerProvider: LoggerProvider;
let tracerProvider: BasicTracerProvider;

function envelopes<T>(direction: string): Envelope<T>[] {
  return logExporter
    .getFinishedLogRecords()
    .filter((record) => record.eventName === `photon.fetch.${direction}`)
    .map((record) => record.body as unknown as Envelope<T>);
}

function payload<T>(direction: string, index = 0): T {
  const value = envelopes<T>(direction)[index]?.payload;
  if (!value) {
    throw new Error(`Missing ${direction} record ${index}`);
  }
  return value;
}

function fakeFetch(
  response: Response = new Response("ok"),
  inspect?: (
    request: Request,
    init: Parameters<typeof fetch>[1]
  ) => Promise<void>
): typeof fetch {
  return (async (input, init) => {
    // The wrapper passes an effective Request, just as native fetch accepts it.
    const request =
      input instanceof Request ? input : new Request(input.toString(), init);
    await inspect?.(request, init);
    return response;
  }) as typeof fetch;
}

function streamResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    })
  );
  return { response, controller };
}

beforeEach(() => {
  logExporter = new InMemoryLogRecordExporter();
  spanExporter = new InMemorySpanExporter();
  loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor(logExporter)],
  });
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable()
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  setActiveProviders({ loggerProvider, tracerProvider });
});

afterEach(async () => {
  await flushFetchRecords({ timeoutMs: 0 });
  await Promise.all([loggerProvider.shutdown(), tracerProvider.shutdown()]);
  clearActiveProviders();
  context.disable();
  propagation.disable();
  trace.disable();
  logs.disable();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("fetch recording", () => {
  it("does not rebuild a consumed Request or claim its missing body is complete", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: "used",
    });
    await request.text();
    let dispatched: unknown;
    const base = ((input: Parameters<typeof fetch>[0]) => {
      dispatched = input;
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;
    await createInstrumentedFetch(base, { record: { preset: "full" } })(
      request
    );
    await flushFetchRecords();
    expect(dispatched).toBe(request);
    expect(payload<FetchRequestRecord>("request").capture.reason).toBe(
      "unavailable_body"
    );
    expect(
      payload<FetchRequestRecord>("request").headers.traceparent
    ).toBeDefined();
  });

  it("drops late response recording after a flush deadline without cancelling fetch", async () => {
    let finish!: (response: Response) => void;
    const base = (() =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })) as unknown as typeof fetch;
    const result = createInstrumentedFetch(base, {
      record: { preset: "full" },
    })("https://example.test");
    await flushFetchRecords({ timeoutMs: 0 });
    const response = new Response("late");
    finish(response);
    expect(await result).toBe(response);
    expect(envelopes("request")).toHaveLength(1);
    expect(envelopes("response")).toHaveLength(0);
  });

  it("rejects cyclic parser output and retains raw evidence", async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await createInstrumentedFetch(fakeFetch(new Response("evidence")), {
      record: { preset: "custom", parseResponse: () => cyclic },
    })("https://example.test");
    await flushFetchRecords();
    expect(payload<FetchResponseRecord>("response").body?.data).toBe(
      "evidence"
    );
    expect(envelopes("response")[0]?.parserError).toBe("invalid_parser_output");
  });

  it("does not record or clone ignored requests", async () => {
    const response = new Response("ok");
    const clone = vi.spyOn(response, "clone");
    await createInstrumentedFetch(fakeFetch(response), {
      ignore: () => true,
      record: { preset: "full" },
    })("https://example.test");
    expect(clone).not.toHaveBeenCalled();
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
    expect(spanExporter.getFinishedSpans()).toHaveLength(0);
  });

  it("captures streamed uploads without consuming the dispatched branch", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("upload"));
        controller.close();
      },
    });
    let sent = "";
    await createInstrumentedFetch(
      fakeFetch(undefined, async (request) => {
        sent = await request.text();
      }),
      { record: { preset: "full" } }
    )("https://example.test", {
      method: "POST",
      body: stream,
      duplex: "half",
    });
    await flushFetchRecords();
    expect(sent).toBe("upload");
    expect(payload<FetchRequestRecord>("request").body?.data).toBe(sent);
  });

  it("retains partial bytes after a stream read error", async () => {
    const { response, controller } = streamResponse();
    await createInstrumentedFetch(fakeFetch(response), {
      record: { preset: "full" },
    })("https://example.test");
    controller.enqueue(new TextEncoder().encode("prefix"));
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.error(new Error("stream broke"));
    await flushFetchRecords();
    expect(payload<FetchResponseRecord>("response")).toMatchObject({
      body: { data: "prefix" },
      capture: { complete: false, reason: "read_failure" },
    });
    await expect(response.text()).rejects.toThrow("stream broke");
  });

  it("marks aborted capture without aborting unrelated streams", async () => {
    const { response, controller } = streamResponse();
    const abort = new AbortController();
    await createInstrumentedFetch(fakeFetch(response), {
      record: { preset: "full" },
    })("https://example.test", { signal: abort.signal });
    abort.abort();
    await flushFetchRecords();
    expect(payload<FetchResponseRecord>("response").capture.reason).toBe(
      "abort"
    );
    controller.close();
    expect(await response.text()).toBe("");
  });

  it("continues the recording branch after application-side cancellation", async () => {
    const { response, controller } = streamResponse();
    await createInstrumentedFetch(fakeFetch(response), {
      record: { preset: "full" },
    })("https://example.test");
    const cancelled = response.body?.cancel();
    controller.enqueue(new TextEncoder().encode("still captured"));
    controller.close();
    await flushFetchRecords();
    await cancelled;
    expect(payload<FetchResponseRecord>("response").body?.data).toBe(
      "still captured"
    );
  });

  it("isolates logger failures from fetch results", async () => {
    const logger = loggerProvider.getLogger("@photon-ai/otel");
    vi.spyOn(loggerProvider, "getLogger").mockReturnValue(logger);
    vi.spyOn(logger, "emit").mockImplementation(() => {
      throw new Error("export failed");
    });
    const response = new Response("ok");
    expect(
      await createInstrumentedFetch(fakeFetch(response), {
        record: { preset: "full" },
      })("https://example.test")
    ).toBe(response);
    await flushFetchRecords();
    expect(await response.text()).toBe("ok");
  });

  it("does not inspect bodies or emit logs when recording is disabled", async () => {
    const response = new Response("untouched");
    const clone = vi.spyOn(response, "clone");
    const fetch = createInstrumentedFetch(fakeFetch(response));
    expect(await fetch("https://example.test")).toBe(response);
    expect(clone).not.toHaveBeenCalled();
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
  });

  it("requires a preset and rejects parser options on non-custom presets", () => {
    const invalid: unknown[] = [
      true,
      null,
      {},
      { preset: "other" },
      { preset: "bounded", parseRequest: () => ({}) },
      { preset: "full", parseResponse: undefined },
      { preset: "full", onParserError: "omit" },
      { preset: "bounded", parserTimeoutMs: 100 },
      { preset: "custom", parseRequest: true },
      { preset: "custom", onParserError: "bad" },
      { preset: "full", maxBodyBytes: -1 },
      { preset: "full", bodyTimeoutMs: Number.NaN },
      { preset: "bounded", maxConcurrentCaptures: 1.5 },
      { preset: "full", headers: "content-type" },
      { preset: "full", headers: [1] },
    ];
    for (const record of invalid) {
      expect(() =>
        createInstrumentedFetch(fakeFetch(), {
          record: record as FetchRecordOptions,
        })
      ).toThrow(TypeError);
    }
  });

  it("restricts parser configuration through its public types", () => {
    type Raw = Extract<FetchRecordOptions, { preset: "bounded" | "full" }>;
    expectTypeOf<Raw["parseRequest"]>().toEqualTypeOf<undefined>();
    expectTypeOf<Raw["parseResponse"]>().toEqualTypeOf<undefined>();
    // @ts-expect-error A preset is mandatory.
    const missing: FetchRecordOptions = {};
    // @ts-expect-error Parsers require custom.
    const wrong: FetchRecordOptions = {
      preset: "full",
      parseResponse: () => null,
    };
    expect(missing).toEqual({});
    expect(wrong.preset).toBe("full");
  });

  it("resolves documented defaults and explicit unlimited overrides", () => {
    expect(resolveFetchRecordOptions({ preset: "bounded" })).toMatchObject({
      maxBodyBytes: 1024 * 1024,
      bodyTimeoutMs: 30_000,
      maxConcurrentCaptures: 32,
    });
    for (const preset of ["full", "custom"] as const) {
      expect(resolveFetchRecordOptions({ preset })).toMatchObject({
        maxBodyBytes: Number.POSITIVE_INFINITY,
        bodyTimeoutMs: Number.POSITIVE_INFINITY,
        maxConcurrentCaptures: Number.POSITIVE_INFINITY,
        headers: "all",
      });
    }
    expect(
      resolveFetchRecordOptions({
        preset: "bounded",
        maxBodyBytes: Number.POSITIVE_INFINITY,
      })?.maxBodyBytes
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("captures raw JSON, effective Request overrides, and propagated headers", async () => {
    let sent = "";
    const fetch = createInstrumentedFetch(
      fakeFetch(new Response('{"ok":true}'), async (request) => {
        sent = await request.text();
      }),
      { record: { preset: "full" } }
    );
    await fetch(
      new Request("https://example.test/orders", {
        method: "POST",
        body: "old",
      }),
      {
        method: "PUT",
        body: '{"id":123}',
        headers: { authorization: "Bearer secret" },
      }
    );
    await flushFetchRecords();
    const request = payload<FetchRequestRecord>("request");
    expect(request.method).toBe("PUT");
    expect(request.body?.data).toBe(sent);
    expect(request.body?.data).toBe('{"id":123}');
    expect(request.headers.authorization).toEqual(["Bearer secret"]);
    expect(request.headers.traceparent?.[0]).toContain(
      spanExporter.getFinishedSpans()[0]?.spanContext().traceId
    );
    expect(payload<FetchResponseRecord>("response").body).toEqual({
      data: '{"ok":true}',
      encoding: "utf8",
      byteLength: 11,
    });
    expect(spanExporter.getFinishedSpans()[0]?.name).toBe("PUT");
  });

  it("uses the exact multipart serialization and preserves transport extensions", async () => {
    let sent = "";
    let contentType: string | null = null;
    let transport: unknown;
    const form = new FormData();
    form.set("name", "example");
    form.set("file", new Blob(["file bytes"]), "sample.txt");
    const fetch = createInstrumentedFetch(
      fakeFetch(undefined, async (request, init) => {
        sent = await request.text();
        contentType = request.headers.get("content-type");
        transport = (init as unknown as { proxy: string }).proxy;
      }),
      { record: { preset: "full" } }
    );
    const init = { method: "POST", body: form, proxy: "http://proxy.test" };
    await fetch("https://example.test/upload", init);
    await flushFetchRecords();
    const recorded = payload<FetchRequestRecord>("request");
    expect(recorded.body?.data).toBe(sent);
    expect(recorded.headers["content-type"]).toEqual([contentType]);
    expect(sent).toContain('filename="sample.txt"');
    expect(transport).toBe(init.proxy);
  });

  it("filters headers and consistently redacts recorded URLs", async () => {
    const response = new Response("ok", {
      headers: { "content-type": "text/plain", authorization: "secret" },
    });
    Object.defineProperty(response, "url", {
      value: "https://example.test/final?token=secret",
    });
    const fetch = createInstrumentedFetch(fakeFetch(response), {
      redactUrl: (url) => sanitizeUrl(url, { params: ["token"] }),
      record: { preset: "bounded" },
    });
    await fetch("https://example.test/?token=secret", {
      headers: { authorization: "secret" },
      referrer: "https://example.test/?token=secret",
    });
    await flushFetchRecords();
    expect(
      payload<FetchRequestRecord>("request").headers.authorization
    ).toBeUndefined();
    expect(
      payload<FetchResponseRecord>("response").headers.authorization
    ).toBeUndefined();
    expect(
      JSON.stringify(
        logExporter.getFinishedLogRecords().map((record) => record.body)
      )
    ).not.toContain("secret");
  });

  it("preserves repeated set-cookie values and explicit header selections", async () => {
    const response = new Response(null, {
      headers: [
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
        ["x-hidden", "no"],
      ],
    });
    const fetch = createInstrumentedFetch(fakeFetch(response), {
      record: { preset: "full", headers: ["SET-COOKIE"] },
    });
    await fetch("https://example.test");
    await flushFetchRecords();
    expect(payload<FetchResponseRecord>("response").headers).toEqual({
      "set-cookie": ["a=1", "b=2"],
    });
  });

  it.each([
    [new Uint8Array([0, 255, 128]), "base64"],
    [new TextEncoder().encode("\ufeffhéllo 🌍"), "utf8"],
  ] as const)("round-trips bytes without content parsing (%s)", async (bytes, encoding) => {
    const response = new Response(bytes);
    const fetch = createInstrumentedFetch(fakeFetch(response), {
      record: { preset: "full" },
    });
    expect(await fetch("https://example.test")).toBe(response);
    expect(response.bodyUsed).toBe(false);
    await flushFetchRecords();
    const body = payload<FetchResponseRecord>("response").body;
    expect(body?.encoding).toBe(encoding);
    expect(
      Buffer.from(body?.data ?? "", encoding === "utf8" ? "utf8" : "base64")
    ).toEqual(Buffer.from(bytes));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("distinguishes absent, empty, and unavailable bodies", async () => {
    const empty = createInstrumentedFetch(fakeFetch(new Response("")), {
      record: { preset: "full" },
    });
    await empty("https://example.test");
    const used = new Response("used");
    await used.text();
    await createInstrumentedFetch(fakeFetch(used), {
      record: { preset: "full" },
    })("https://example.test");
    await flushFetchRecords();
    expect(payload<FetchRequestRecord>("request").body).toBeNull();
    expect(payload<FetchResponseRecord>("response").body).toEqual({
      data: "",
      encoding: "utf8",
      byteLength: 0,
    });
    expect(payload<FetchResponseRecord>("response", 1).capture).toMatchObject({
      complete: false,
      reason: "unavailable_body",
    });
  });

  it("marks truncated multibyte bodies without replacing bytes", async () => {
    const fetch = createInstrumentedFetch(fakeFetch(new Response("🌍")), {
      record: { preset: "bounded", maxBodyBytes: 2 },
    });
    await fetch("https://example.test");
    await flushFetchRecords();
    expect(payload<FetchResponseRecord>("response")).toMatchObject({
      body: { encoding: "base64", data: "8J8=", byteLength: 2 },
      capture: { capturedBytes: 2, complete: false, reason: "size_limit" },
    });
  });

  it("recognizes EOF exactly at the byte limit", async () => {
    const fetch = createInstrumentedFetch(fakeFetch(new Response("exact")), {
      record: { preset: "bounded", maxBodyBytes: 5 },
    });
    await fetch("https://example.test");
    await flushFetchRecords();
    expect(payload<FetchResponseRecord>("response").capture.complete).toBe(
      true
    );
  });

  it("returns an unread stream immediately, ends the span, and logs after EOF", async () => {
    const { response, controller } = streamResponse();
    const fetch = createInstrumentedFetch(fakeFetch(response), {
      record: { preset: "full" },
    });
    expect(await fetch("https://example.test")).toBe(response);
    expect(spanExporter.getFinishedSpans()).toHaveLength(1);
    expect(envelopes("response")).toHaveLength(0);
    controller.enqueue(new TextEncoder().encode("streamed"));
    controller.close();
    await flushFetchRecords();
    expect(payload<FetchResponseRecord>("response").body?.data).toBe(
      "streamed"
    );
    expect(await response.text()).toBe("streamed");
    const log = logExporter
      .getFinishedLogRecords()
      .find((record) => record.eventName === "photon.fetch.response");
    expect(log?.spanContext).toEqual(
      spanExporter.getFinishedSpans()[0]?.spanContext()
    );
  });

  it.each([
    "timeout",
    "shutdown",
  ] as const)("emits a prefix on %s without cancelling the application stream", async (reason) => {
    const { response, controller } = streamResponse();
    const fetch = createInstrumentedFetch(fakeFetch(response), {
      record: {
        preset: "full",
        bodyTimeoutMs: reason === "timeout" ? 10 : Number.POSITIVE_INFINITY,
      },
    });
    await fetch("https://example.test");
    controller.enqueue(new TextEncoder().encode("prefix"));
    await new Promise((resolve) => setTimeout(resolve, 1));
    await flushFetchRecords({ timeoutMs: reason === "shutdown" ? 0 : 1000 });
    expect(payload<FetchResponseRecord>("response")).toMatchObject({
      body: { data: "prefix" },
      capture: { complete: false, reason },
    });
    controller.enqueue(new TextEncoder().encode("-rest"));
    controller.close();
    expect(await response.text()).toBe("prefix-rest");
  });

  it("records metadata when capacity is exceeded and releases slots", async () => {
    const first = streamResponse();
    let count = 0;
    const base = (async () =>
      ++count === 1
        ? first.response
        : new Response("next")) as unknown as typeof fetch;
    const fetch = createInstrumentedFetch(base, {
      record: { preset: "bounded", maxConcurrentCaptures: 1 },
    });
    await fetch("https://example.test/first");
    await fetch("https://example.test/second");
    await vi.waitFor(() => expect(envelopes("response")).toHaveLength(1));
    expect(payload<FetchResponseRecord>("response").capture.reason).toBe(
      "capacity_limit"
    );
    first.controller.close();
    await flushFetchRecords();
    await fetch("https://example.test/third");
    await flushFetchRecords();
    expect(payload<FetchResponseRecord>("response", 2).body?.data).toBe("next");
  });

  it("supports whole-record sync/async parsers only in custom", async () => {
    const parseRequest = vi.fn((request: FetchRequestRecord) => ({
      method: request.method,
    }));
    const parseResponse = vi.fn(async (response: FetchResponseRecord) => {
      await Promise.resolve();
      return {
        parsed: JSON.parse(response.body?.data ?? "null"),
        headers: response.headers,
      };
    });
    await createInstrumentedFetch(fakeFetch(new Response('{"ok":true}')), {
      record: { preset: "custom", parseRequest, parseResponse },
    })("https://example.test");
    await flushFetchRecords();
    expect(payload("request")).toEqual({ method: "GET" });
    expect(payload("response")).toMatchObject({ parsed: { ok: true } });
    expect(parseRequest).toHaveBeenCalledTimes(1);
    expect(parseResponse).toHaveBeenCalledTimes(1);
    expect(envelopes("response")[0]?.capture.complete).toBe(true);
  });

  it("retains untouched raw fallback after parser mutation and failure", async () => {
    await createInstrumentedFetch(fakeFetch(new Response("original")), {
      record: {
        preset: "custom",
        parseResponse: (record) => {
          if (record.body) {
            record.body.data = "mutated";
          }
          record.capture.complete = false;
          throw new Error("parser failure");
        },
      },
    })("https://example.test");
    await flushFetchRecords();
    expect(payload<FetchResponseRecord>("response").body?.data).toBe(
      "original"
    );
    expect(envelopes("response")[0]?.capture.complete).toBe(true);
    expect(envelopes("response")[0]?.parserError).toBeDefined();
  });

  it.each([
    undefined,
    Number.NaN,
    1n,
    new Date(),
    { bad: undefined },
  ])("rejects invalid parser output %s without losing the raw body", async (value) => {
    await createInstrumentedFetch(fakeFetch(new Response("raw")), {
      record: { preset: "custom", parseResponse: () => value },
    })("https://example.test");
    await flushFetchRecords();
    expect(payload<FetchResponseRecord>("response").body?.data).toBe("raw");
    expect(envelopes("response")[0]?.parserError).toBeDefined();
  });

  it("omits payload and parser exception text when omission is selected", async () => {
    await createInstrumentedFetch(fakeFetch(new Response("private")), {
      record: {
        preset: "custom",
        onParserError: "omit",
        parseResponse: () => {
          throw new Error("private");
        },
      },
    })("https://example.test");
    await flushFetchRecords();
    expect(envelopes("response")[0]?.payload).toBeUndefined();
    expect(JSON.stringify(envelopes("response"))).not.toContain("private");
  });

  it("bounds hanging parsers and suppresses recursive instrumented fetches", async () => {
    let fetch: typeof globalThis.fetch;
    let calls = 0;
    const base = (() => {
      calls += 1;
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;
    fetch = createInstrumentedFetch(base, {
      record: {
        preset: "custom",
        parserTimeoutMs: 10,
        parseResponse: async () => {
          await fetch("https://example.test/parser");
          return await new Promise(() => undefined);
        },
      },
    });
    await fetch("https://example.test");
    await flushFetchRecords();
    expect(calls).toBe(2);
    expect(spanExporter.getFinishedSpans()).toHaveLength(1);
    expect(envelopes("response")[0]?.parserError).toBeDefined();
  });

  it("flush interrupts even an unlimited parser and prevents late duplicate logs", async () => {
    let finish!: (value: unknown) => void;
    const started = vi.fn();
    await createInstrumentedFetch(fakeFetch(), {
      record: {
        preset: "custom",
        parserTimeoutMs: Number.POSITIVE_INFINITY,
        parseResponse: () => {
          started();
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    })("https://example.test");
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    await flushFetchRecords({ timeoutMs: 0 });
    expect(envelopes("response")).toHaveLength(1);
    finish({ late: true });
    await Promise.resolve();
    expect(envelopes("response")).toHaveLength(1);
  });

  it("records network errors without a fabricated response or changing the rejection", async () => {
    const error = new TypeError("network failed");
    const base = (() => Promise.reject(error)) as unknown as typeof fetch;
    const fetch = createInstrumentedFetch(base, { record: { preset: "full" } });
    await expect(
      fetch("https://example.test", { method: "POST", body: "evidence" })
    ).rejects.toBe(error);
    await flushFetchRecords();
    expect(payload<FetchRequestRecord>("request").body?.data).toBe("evidence");
    expect(envelopes("response")).toHaveLength(0);
    expect(
      logExporter
        .getFinishedLogRecords()
        .find((record) => record.eventName === "photon.fetch.error")?.body
    ).toMatchObject({
      error: { name: "TypeError", message: "network failed" },
    });
  });

  it("uses the original provider for delayed records even when the active provider changes", async () => {
    const { response, controller } = streamResponse();
    await createInstrumentedFetch(fakeFetch(response), {
      record: { preset: "full" },
    })("https://example.test");
    const otherExporter = new InMemoryLogRecordExporter();
    const other = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(otherExporter)],
    });
    setActiveProviders({ loggerProvider: other, tracerProvider });
    controller.close();
    await flushFetchRecords();
    expect(envelopes("response")).toHaveLength(1);
    expect(otherExporter.getFinishedLogRecords()).toHaveLength(0);
    await other.shutdown();
  });
});
