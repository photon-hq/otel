import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createInstrumentedFetch } from "../../src/instrument-fetch";
import { setupOtel } from "../../src/setup";

interface OtlpValue {
  arrayValue?: { values?: OtlpValue[] };
  boolValue?: boolean;
  doubleValue?: number;
  intValue?: number | string;
  kvlistValue?: { values?: { key: string; value: OtlpValue }[] };
  stringValue?: string;
}

interface WireLog {
  body?: OtlpValue;
  eventName?: string;
  spanId?: string;
  traceId?: string;
}

function decode(value: OtlpValue): unknown {
  if (value.kvlistValue) {
    return Object.fromEntries(
      (value.kvlistValue.values ?? []).map((entry) => [
        entry.key,
        decode(entry.value),
      ])
    );
  }
  if (value.arrayValue) {
    return (value.arrayValue.values ?? []).map(decode);
  }
  if (value.intValue !== undefined) {
    return Number(value.intValue);
  }
  return value.stringValue ?? value.boolValue ?? value.doubleValue ?? null;
}

async function readLogs(nonce: string): Promise<WireLog[]> {
  const output =
    process.env.COLLECTOR_OUTPUT_DIR ?? join(import.meta.dirname, "output");
  const data = await readFile(join(output, "logs.json"), "utf8");
  const result: WireLog[] = [];
  for (const line of data.trim().split("\n")) {
    try {
      const parsed = JSON.parse(line) as {
        resourceLogs?: {
          resource?: { attributes?: { key: string; value: OtlpValue }[] };
          scopeLogs?: { logRecords?: WireLog[] }[];
        }[];
      };
      for (const resource of parsed.resourceLogs ?? []) {
        if (
          !resource.resource?.attributes?.some(
            (attribute) =>
              attribute.key === "test.record.nonce" &&
              attribute.value.stringValue === nonce
          )
        ) {
          continue;
        }
        for (const scope of resource.scopeLogs ?? []) {
          result.push(...(scope.logRecords ?? []));
        }
      }
    } catch {
      // The Collector may currently be appending this line.
    }
  }
  return result;
}

describe("fetch record OTLP round-trip", () => {
  it("exports structured raw/custom records, trace correlation, and drains response bodies at shutdown", async () => {
    const nonce = crypto.randomUUID();
    const original = globalThis.fetch;
    const sentBodies: string[] = [];
    const sentLengths: (string | undefined)[] = [];
    const target = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        sentBodies.push(Buffer.concat(chunks).toString());
        sentLengths.push(request.headers["content-length"]);
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": ["a=1", "b=2"],
        });
        response.write('{"ok":');
        setTimeout(() => response.end("true}"), 50);
      });
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve)
    );
    const { port } = target.address() as AddressInfo;
    const handle = setupOtel({
      serviceName: "fetch-record-integration",
      endpoint: "http://localhost:4318",
      resourceAttributes: { "test.record.nonce": nonce },
      logLevel: "silent",
      instrumentFetch: { record: { preset: "full" } },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/raw`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"order":123}',
      });
      const custom = createInstrumentedFetch(original, {
        record: {
          preset: "custom",
          parseResponse: (record) => ({
            ...record,
            parsed: JSON.parse(record.body?.data ?? "null"),
          }),
        },
      });
      const parsedResponse = await custom(`http://127.0.0.1:${port}/custom`);
      const streamed = await fetch(`http://127.0.0.1:${port}/stream`, {
        method: "POST",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("streamed upload"));
            controller.close();
          },
        }),
        duplex: "half",
      });
      // Neither body is consumed by the application before shutdown.
      await handle.shutdown();
      expect(await response.text()).toBe('{"ok":true}');
      expect(await parsedResponse.text()).toBe('{"ok":true}');
      expect(await streamed.text()).toBe('{"ok":true}');
      expect(sentBodies).toEqual(['{"order":123}', "", "streamed upload"]);
      expect(sentLengths[0]).toBe(
        String(Buffer.byteLength(sentBodies[0] ?? ""))
      );

      let records: WireLog[] = [];
      await vi.waitFor(
        async () => {
          records = await readLogs(nonce);
          expect(records).toHaveLength(6);
        },
        { timeout: 15_000, interval: 250 }
      );
      const decoded = records.map((record) => ({
        ...record,
        envelope: decode(record.body ?? {}) as {
          capture: { complete: boolean };
          payload: {
            url: string;
            body: { data: string; encoding: string };
            headers: Record<string, string[]>;
            parsed?: unknown;
          };
        },
      }));
      const rawRequest = decoded.find(
        (record) =>
          record.eventName === "photon.fetch.request" &&
          record.envelope.payload.url.endsWith("/raw")
      );
      const rawResponse = decoded.find(
        (record) =>
          record.eventName === "photon.fetch.response" &&
          record.envelope.payload.url.endsWith("/raw")
      );
      const customResponse = decoded.find(
        (record) =>
          record.eventName === "photon.fetch.response" &&
          record.envelope.payload.url.endsWith("/custom")
      );
      expect(rawRequest?.envelope.payload.body.data).toBe(sentBodies[0]);
      expect(rawResponse?.envelope.payload.body).toMatchObject({
        data: '{"ok":true}',
        encoding: "utf8",
      });
      expect(rawResponse?.envelope.payload.headers["set-cookie"]).toEqual([
        "a=1",
        "b=2",
      ]);
      expect(rawResponse?.envelope.capture.complete).toBe(true);
      expect(customResponse?.envelope.payload.parsed).toEqual({ ok: true });
      expect(rawRequest?.traceId).toBeTruthy();
      expect(rawRequest?.traceId).toBe(rawResponse?.traceId);
      expect(rawRequest?.spanId).toBeTruthy();
      expect(rawRequest?.spanId).toBe(rawResponse?.spanId);
    } finally {
      await handle.shutdown();
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
      globalThis.fetch = original;
    }
  });
});
