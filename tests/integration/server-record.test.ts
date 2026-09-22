import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import {
  createHttpServerRecorder,
  createRpcServerRecorder,
} from "../../src/server-record";
import { setupOtel } from "../../src/setup";
import { decode, readLogs } from "./record-output";

describe("server record OTLP round-trip", () => {
  it("exports actual HTTP response content and unary RPC records with their server trace context", async () => {
    const nonce = crypto.randomUUID();
    const otel = setupOtel({
      serviceName: "server-record-integration",
      endpoint: "http://localhost:4318",
      resourceAttributes: { "test.record.nonce": nonce },
      instrumentFetch: false,
      logLevel: "silent",
    });
    const recordHttp = createHttpServerRecorder({
      record: { preset: "bounded" },
    });
    const recordRpc = createRpcServerRecorder({
      record: { preset: "bounded" },
    });
    const tracer = otel.tracerProvider.getTracer("server-test");
    const expected = { lines: [{ id: "line-1", status: "unknown" }] };
    let httpTrace = "";
    const target = createServer((_request, response) => {
      const span = tracer.startSpan("GET /lines", { kind: SpanKind.SERVER });
      httpTrace = span.spanContext().traceId;
      context.with(trace.setSpan(context.active(), span), () => {
        const recording = recordHttp(new Request("http://localhost/lines"), {
          requestId: nonce,
        });
        recording.response(Response.json(expected));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(expected));
        span.end();
      });
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve)
    );
    try {
      const { port } = target.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/lines`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);

      const rpcSpan = tracer.startSpan("Directory/ListLines", {
        kind: SpanKind.SERVER,
      });
      const call = recordRpc({
        service: "Directory",
        method: "ListLines",
        system: "grpc",
        message: () => ({ pageSize: 10 }),
        context: trace.setSpan(context.active(), rpcSpan),
      });
      call.response(() => ({
        lines: [{ id: "line-2", version: "9007199254740993" }],
      }));
      rpcSpan.end();

      await otel.shutdown();
      await vi.waitFor(
        async () => {
          const records = await readLogs(nonce);
          expect(records).toHaveLength(4);
          const http = records.find(
            (item) => item.eventName === "photon.http.server.response"
          );
          expect(http?.traceId).toBe(httpTrace);
          expect(http?.spanId).toBeTruthy();
          expect(decode(http?.body ?? {})).toMatchObject({
            requestId: nonce,
            capture: { complete: true },
            payload: { status: 200, body: { data: JSON.stringify(expected) } },
          });
          const rpc = records.find(
            (item) => item.eventName === "photon.rpc.server.response"
          );
          expect(rpc?.traceId).toBe(rpcSpan.spanContext().traceId);
          expect(decode(rpc?.body ?? {})).toMatchObject({
            capture: { complete: true },
            payload: {
              code: "OK",
              system: "grpc",
              body: {
                data: '{"lines":[{"id":"line-2","version":"9007199254740993"}]}',
              },
            },
          });
        },
        { timeout: 15_000, interval: 250 }
      );
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
      await otel.shutdown();
    }
  });
});
