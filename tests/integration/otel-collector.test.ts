import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger";
import { IS_BUN } from "../../src/runtime";
import { sanitizeEmail, sanitizeErrorMessage } from "../../src/sanitize";
import { setupOtel } from "../../src/setup";
import { PHOTON_OTEL_VERSION } from "../../src/version";
import { withSpan } from "../../src/with-span";

/**
 * End-to-end integration test: drives the public API against a REAL
 * OpenTelemetry Collector (started via tests/integration/docker-compose.yml)
 * and asserts on what the collector actually received, read back from its
 * `file` exporter output. This exercises the full path the unit tests can't:
 * exporter URL resolution, batch-flush-on-shutdown, OTLP/HTTP over the wire,
 * and the collector's own parsing.
 *
 * Prerequisite: the collector must be running and reachable at
 * OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318). See README.md.
 */

const SERVICE_NAME = "photon-otel-integration";
const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;
const HOOK_TIMEOUT_MS = 60_000;

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.COLLECTOR_OUTPUT_DIR ?? join(here, "output");
const tracesFile = join(outputDir, "traces.json");
const logsFile = join(outputDir, "logs.json");
// The OTEL_INSTRUMENT_FETCH=false case runs in a child process (see below); it
// imports the built bundle, so the integration suite needs `bun run build`.
const childScript = join(here, "disabled-fetch.child.mjs");
const distEntry = join(here, "..", "..", "dist", "index.js");

// Tag this run's telemetry so assertions match exactly our data even if the
// collector's output files contain spans/logs from a previous run.
const nonce = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const happySpanName = `integration-happy-${nonce}`;
const errorSpanName = `integration-error-${nonce}`;
const fetchParentSpanName = `integration-fetch-parent-${nonce}`;
const fetchMarker = `integration-fetch-${nonce}`;
// Tags for the separate OTEL_INSTRUMENT_FETCH=false child run.
const disabledNonce = `${nonce}-disabled`;
const disabledParentSpanName = `integration-disabled-parent-${nonce}`;
const disabledFetchMarker = `integration-disabled-fetch-${nonce}`;
const rawEmail = "user@example.com";

// --- OTLP/JSON shapes emitted by the collector's file exporter ---------------

interface OtlpValue {
  boolValue?: boolean;
  doubleValue?: number;
  intValue?: string | number;
  stringValue?: string;
}
interface OtlpAttr {
  key: string;
  value?: OtlpValue;
}
interface OtlpResource {
  attributes?: OtlpAttr[];
}
interface OtlpStatus {
  code?: number | string;
  message?: string;
}
interface OtlpSpan {
  attributes?: OtlpAttr[];
  name?: string;
  parentSpanId?: string;
  spanId?: string;
  status?: OtlpStatus;
  traceId?: string;
}
interface OtlpResourceSpans {
  resource?: OtlpResource;
  scopeSpans?: { spans?: OtlpSpan[] }[];
}
interface OtlpTracesData {
  resourceSpans?: OtlpResourceSpans[];
}
interface OtlpLogRecord {
  attributes?: OtlpAttr[];
  body?: { stringValue?: string };
  severityNumber?: number;
  severityText?: string;
  traceId?: string;
}
interface OtlpResourceLogs {
  resource?: OtlpResource;
  scopeLogs?: { logRecords?: OtlpLogRecord[] }[];
}
interface OtlpLogsData {
  resourceLogs?: OtlpResourceLogs[];
}

type AttrMap = Record<string, string | number | boolean>;

interface CollectedSpan {
  attributes: AttrMap;
  name: string;
  parentSpanId: string;
  resource: AttrMap;
  spanId: string;
  status: OtlpStatus;
  traceId: string;
}
interface CollectedLog {
  attributes: AttrMap;
  body?: string;
  resource: AttrMap;
  severityText?: string;
  traceId?: string;
}

// --- Parsing helpers ---------------------------------------------------------

function attrValue(
  value: OtlpValue | undefined
): string | number | boolean | undefined {
  if (!value) {
    return;
  }
  if (value.stringValue !== undefined) {
    return value.stringValue;
  }
  if (value.boolValue !== undefined) {
    return value.boolValue;
  }
  if (value.intValue !== undefined) {
    return Number(value.intValue);
  }
  if (value.doubleValue !== undefined) {
    return value.doubleValue;
  }
  return;
}

function attrsToMap(attrs: OtlpAttr[] | undefined): AttrMap {
  const out: AttrMap = {};
  for (const attr of attrs ?? []) {
    const value = attrValue(attr.value);
    if (value !== undefined) {
      out[attr.key] = value;
    }
  }
  return out;
}

function readLines(file: string): string[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readSpans(targetNonce: string = nonce): CollectedSpan[] {
  const spans: CollectedSpan[] = [];
  for (const line of readLines(tracesFile)) {
    let parsed: OtlpTracesData;
    try {
      parsed = JSON.parse(line) as OtlpTracesData;
    } catch {
      continue;
    }
    for (const rs of parsed.resourceSpans ?? []) {
      const resource = attrsToMap(rs.resource?.attributes);
      for (const scope of rs.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          spans.push({
            name: span.name ?? "",
            traceId: span.traceId ?? "",
            spanId: span.spanId ?? "",
            parentSpanId: span.parentSpanId ?? "",
            attributes: attrsToMap(span.attributes),
            status: span.status ?? {},
            resource,
          });
        }
      }
    }
  }
  // Scope to a specific run: the file exporter appends across runs, and log
  // bodies aren't unique, so filter by the per-run nonce carried on the
  // resource. Defaults to the main enabled run; the child run passes its own.
  return spans.filter((s) => s.resource["test.nonce"] === targetNonce);
}

function readLogs(): CollectedLog[] {
  const records: CollectedLog[] = [];
  for (const line of readLines(logsFile)) {
    let parsed: OtlpLogsData;
    try {
      parsed = JSON.parse(line) as OtlpLogsData;
    } catch {
      continue;
    }
    for (const rl of parsed.resourceLogs ?? []) {
      const resource = attrsToMap(rl.resource?.attributes);
      for (const scope of rl.scopeLogs ?? []) {
        for (const record of scope.logRecords ?? []) {
          records.push({
            body: record.body?.stringValue,
            severityText: record.severityText,
            attributes: attrsToMap(record.attributes),
            traceId: record.traceId,
            resource,
          });
        }
      }
    }
  }
  return records.filter((r) => r.resource["test.nonce"] === nonce);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  read: () => T[],
  done: (items: T[]) => boolean
): Promise<T[]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let items = read();
  while (!done(items) && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    items = read();
  }
  return items;
}

// `STATUS_CODE_*` enums may serialize as the numeric value or the string name
// depending on the collector's JSON marshaler — accept both.
function isOkStatus(status: OtlpStatus | undefined): boolean {
  return status?.code === 1 || status?.code === "STATUS_CODE_OK";
}
function isErrorStatus(status: OtlpStatus | undefined): boolean {
  return status?.code === 2 || status?.code === "STATUS_CODE_ERROR";
}

// --- Drive the library, then collect what the collector received -------------

let spans: CollectedSpan[] = [];
let logRecords: CollectedLog[] = [];
let disabledSpans: CollectedSpan[] = [];
let errorSpanRejected = false;

/**
 * Run the OTEL_INSTRUMENT_FETCH=false scenario in its own process (clean global
 * OTel state) under the SAME runtime as the suite (`process.execPath`), so the
 * disable is verified end-to-end on whichever of Bun/Node is running. Resolves
 * when the child exits 0; rejects on spawn error or a non-zero exit.
 */
function runDisabledFetchChild(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript], {
      stdio: "inherit",
      env: {
        ...process.env,
        OTEL_INSTRUMENT_FETCH: "false",
        OTEL_EXPORTER_OTLP_ENDPOINT:
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
        CHILD_NONCE: disabledNonce,
        CHILD_PARENT_SPAN: disabledParentSpanName,
        CHILD_FETCH_MARKER: disabledFetchMarker,
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`disabled-fetch child exited with code ${code}`));
      }
    });
  });
}

beforeAll(async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://localhost:4318";
  // Keep level resolution deterministic regardless of the CI environment
  // (LOG_LEVEL would otherwise win over the logLevel option below).
  delete process.env.LOG_LEVEL;

  if (!existsSync(distEntry)) {
    throw new Error(
      `Missing ${distEntry}. The OTEL_INSTRUMENT_FETCH=false child imports the built bundle — run \`bun run build\` before the integration test.`
    );
  }

  const handle = setupOtel({
    serviceName: SERVICE_NAME,
    serviceVersion: PHOTON_OTEL_VERSION,
    resourceAttributes: { "test.nonce": nonce },
    logLevel: "debug",
  });
  const log = createLogger("integration");

  // Happy path: span with attributes wrapping a log (for trace correlation).
  await withSpan(happySpanName, { "test.case": "happy" }, async () => {
    log.info("hello from integration", { foo: "bar" });
    await Promise.resolve();
  });

  // Error path: span records the exception and PII-scrubs the status message.
  try {
    await withSpan(errorSpanName, () => {
      throw new Error(`contact ${rawEmail}`);
    });
  } catch {
    errorSpanRejected = true;
  }

  // Standalone error log carrying exception.* attributes.
  log.error("integration error log", { code: "E_TEST" }, new Error("boom"));

  // Outbound fetch: setupOtel auto-instruments fetch (native undici on Node,
  // globalThis.fetch wrap on Bun), so this emits a CLIENT span parented to the
  // active span. A local server is the target so the test never touches the
  // network; the nonce in the path makes the span identifiable by `url.full`.
  const target = createServer((_req, res) => {
    res.statusCode = 200;
    res.end("ok");
  });
  await new Promise<void>((resolve) => {
    target.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = target.address() as AddressInfo;
  await withSpan(fetchParentSpanName, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/${fetchMarker}`);
    await res.text();
  });
  await new Promise<void>((resolve) => {
    target.close(() => resolve());
  });

  // Flush the batch processors over the wire before reading the collector files.
  await handle.shutdown();

  // Separately, drive the OTEL_INSTRUMENT_FETCH=false scenario in a clean child
  // process (setupOtel is process-global and idempotent, so it can't share this
  // process with the enabled run above).
  await runDisabledFetchChild();

  spans = await pollUntil(
    readSpans,
    (items) =>
      items.some((s) => s.name === happySpanName) &&
      items.some((s) => s.name === errorSpanName) &&
      items.some((s) =>
        String(s.attributes["url.full"] ?? "").includes(fetchMarker)
      )
  );
  logRecords = await pollUntil(
    readLogs,
    (items) =>
      items.some((r) => r.body === "hello from integration") &&
      items.some((r) => r.body === "integration error log")
  );
  // Wait for the child run's control (parent) span so that asserting the absence
  // of a fetch span below is meaningful — the child's pipeline did deliver.
  disabledSpans = await pollUntil(
    () => readSpans(disabledNonce),
    (items) => items.some((s) => s.name === disabledParentSpanName)
  );
}, HOOK_TIMEOUT_MS);

describe("real OTLP/HTTP round-trip to an OpenTelemetry Collector", () => {
  it("rejects out of the error span (drive sanity check)", () => {
    expect(errorSpanRejected).toBe(true);
  });

  it("delivers the happy span with attributes, OK status, and service resource", () => {
    const span = spans.find((s) => s.name === happySpanName);
    expect(span).toBeDefined();
    expect(span?.attributes["test.case"]).toBe("happy");
    expect(isOkStatus(span?.status)).toBe(true);
    expect(span?.resource["service.name"]).toBe(SERVICE_NAME);
    expect(span?.resource["service.version"]).toBe(PHOTON_OTEL_VERSION);
    expect(span?.resource["test.nonce"]).toBe(nonce);
    expect(span?.resource["deployment.environment"]).toBeDefined();
  });

  it("delivers the error span with ERROR status and a PII-scrubbed message", () => {
    const span = spans.find((s) => s.name === errorSpanName);
    expect(span).toBeDefined();
    expect(span?.attributes["error.type"]).toBe("Error");
    expect(isErrorStatus(span?.status)).toBe(true);
    expect(span?.status.message).toBe(
      sanitizeErrorMessage(`contact ${rawEmail}`)
    );
    expect(span?.status.message).toContain(sanitizeEmail(rawEmail));
    expect(span?.status.message ?? "").not.toContain(rawEmail);
  });

  it("delivers the info log with severity, module, and user attributes", () => {
    const record = logRecords.find((r) => r.body === "hello from integration");
    expect(record).toBeDefined();
    expect(record?.severityText).toBe("INFO");
    expect(record?.attributes["log.module"]).toBe("integration");
    expect(record?.attributes.foo).toBe("bar");
  });

  it("delivers the error log with ERROR severity and exception attributes", () => {
    const record = logRecords.find((r) => r.body === "integration error log");
    expect(record).toBeDefined();
    expect(record?.severityText).toBe("ERROR");
    expect(record?.attributes.code).toBe("E_TEST");
    expect(record?.attributes["exception.type"]).toBe("Error");
    expect(record?.attributes["exception.message"]).toBe("boom");
  });

  it("correlates the in-span log with its span via a shared trace_id", () => {
    const span = spans.find((s) => s.name === happySpanName);
    const record = logRecords.find((r) => r.body === "hello from integration");
    expect(span?.traceId).toBeTruthy();
    expect(record?.traceId).toBe(span?.traceId);
  });

  it("delivers an auto-instrumented fetch CLIENT span with HTTP attributes", () => {
    const span = spans.find((s) =>
      String(s.attributes["url.full"] ?? "").includes(fetchMarker)
    );
    expect(span).toBeDefined();
    expect(span?.name).toBe("GET");
    expect(span?.attributes["http.request.method"]).toBe("GET");
    expect(span?.attributes["server.address"]).toBe("127.0.0.1");
    expect(span?.attributes["http.response.status_code"]).toBe(200);
    expect(span?.resource["service.name"]).toBe(SERVICE_NAME);
    expect(span?.resource["test.nonce"]).toBe(nonce);
    // A 200 is never an error on either runtime.
    expect(isErrorStatus(span?.status)).toBe(false);
    if (IS_BUN) {
      // The global-fetch wrap sets OK explicitly.
      expect(isOkStatus(span?.status)).toBe(true);
    } else {
      // Native undici follows HTTP semconv (2xx status left UNSET) and records
      // url.scheme — which the wrap does not — proving the Node leg used undici.
      expect(span?.attributes["url.scheme"]).toBe("http");
    }
  });

  it("parents the fetch span under the active span (shared trace + parent id)", () => {
    const parent = spans.find((s) => s.name === fetchParentSpanName);
    const fetchSpan = spans.find((s) =>
      String(s.attributes["url.full"] ?? "").includes(fetchMarker)
    );
    expect(parent?.spanId).toBeTruthy();
    expect(fetchSpan?.traceId).toBe(parent?.traceId);
    expect(fetchSpan?.parentSpanId).toBe(parent?.spanId);
  });

  it("suppresses the fetch CLIENT span when OTEL_INSTRUMENT_FETCH=false", () => {
    // Control: the child run's parent span DID reach the collector, so the
    // absence of a fetch span is meaningful (the pipeline ran, just no fetch).
    const parent = disabledSpans.find((s) => s.name === disabledParentSpanName);
    expect(parent).toBeDefined();
    // No CLIENT fetch span was emitted for the disabled run...
    const fetchSpan = disabledSpans.find((s) =>
      String(s.attributes["url.full"] ?? "").includes(disabledFetchMarker)
    );
    expect(fetchSpan).toBeUndefined();
    // ...and the control span has no child spans at all (the fetch was its only
    // call) — true on both runtimes: native undici on Node never registered, and
    // the globalThis.fetch wrap on Bun was never installed.
    const children = disabledSpans.filter(
      (s) => s.parentSpanId === parent?.spanId
    );
    expect(children).toHaveLength(0);
  });
});
