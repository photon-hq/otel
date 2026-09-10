import { type Context, context, diag } from "@opentelemetry/api";
import {
  type LogBody,
  type Logger,
  SeverityNumber,
} from "@opentelemetry/api-logs";
import { suppressTracing } from "@opentelemetry/core";
import { FetchBodyCapture } from "./fetch-record-body";
import {
  type FetchCaptureReason,
  type FetchRecordCapture,
  type FetchRecordParser,
  type FetchRequestRecord,
  type FetchResponseRecord,
  type ResolvedFetchRecordOptions,
  validateFlushTimeout,
} from "./fetch-record-options";
import { resolveLogger } from "./scope";
import { PHOTON_OTEL_VERSION } from "./version";

type FetchRecord = FetchRequestRecord | FetchResponseRecord;
type RecordMetadata<T extends FetchRecord> = Omit<
  T,
  "body" | "capture" | "finishedAt"
>;

interface PendingRecording {
  done: Promise<void>;
  stop(): void;
}

// Share lifecycle tracking when Bun source and the published bundle coexist.
const REGISTRY = Symbol.for("@photon-ai/otel.fetch.records");
const registryHost = globalThis as unknown as Record<
  symbol,
  Set<PendingRecording> | undefined
>;
const pending = registryHost[REGISTRY] ?? new Set<PendingRecording>();
registryHost[REGISTRY] = pending;
const DEFAULT_FLUSH_TIMEOUT_MS = 5000;

function diagnostic(): void {
  try {
    diag.warn("[@photon-ai/otel] Fetch record could not be emitted");
  } catch {
    // Diagnostics must not change the fetch outcome either.
  }
}

function selectHeaders(
  headers: Headers,
  selection: ResolvedFetchRecordOptions["headers"]
): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null);
  for (const [name, value] of headers) {
    if (selection === "all" || selection.has(name)) {
      result[name] = [value];
    }
  }
  if (result["set-cookie"] && typeof headers.getSetCookie === "function") {
    result["set-cookie"] = headers.getSetCookie();
  }
  return result;
}

function recordedUrl(url: string, redactUrl?: (url: string) => string): string {
  if (!(url && redactUrl)) {
    return url;
  }
  try {
    return redactUrl(url);
  } catch {
    // Never fall back to an unredacted URL after a redactor fails.
    return "REDACTED";
  }
}

function requestOptions(
  request: Request,
  redactUrl?: (url: string) => string
): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (const key of [
    "cache",
    "credentials",
    "integrity",
    "keepalive",
    "mode",
    "redirect",
    "referrerPolicy",
  ] as const) {
    const value = request[key];
    if (typeof value === "string" || typeof value === "boolean") {
      options[key] = value;
    }
  }
  options.referrer = recordedUrl(request.referrer, redactUrl);
  options.signalAborted = request.signal.aborted;
  if ("duplex" in request && typeof request.duplex === "string") {
    options.duplex = request.duplex;
  }
  return options;
}

/** Reject values JSON would silently lose or rewrite, including cycles and NaN. */
function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError("Parser output must be JSON-compatible");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    !(
      Array.isArray(value) ||
      prototype === Object.prototype ||
      prototype === null
    )
  ) {
    throw new TypeError(
      "Parser output must contain only plain objects and arrays"
    );
  }
  ancestors.add(value);
  for (const child of Object.values(value)) {
    assertJson(child, ancestors);
  }
  ancestors.delete(value);
}

function jsonSnapshot(value: unknown): LogBody {
  assertJson(value);
  return JSON.parse(JSON.stringify(value)) as LogBody;
}

interface ParsedRecord {
  parserError?: string;
  parserErrorDetails?: { name: string; message: string; stack?: string };
  payload?: LogBody;
}

function errorDetails(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: typeof error, message: String(error) };
}

async function parseRecord<T extends FetchRecord>(
  raw: T,
  parser: FetchRecordParser<T> | undefined,
  options: ResolvedFetchRecordOptions,
  signal: AbortSignal
): Promise<ParsedRecord> {
  if (!parser) {
    return { payload: jsonSnapshot(raw) };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let validating = false;
  let interrupt: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => reject(new Error("parser_shutdown"));
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) {
      interrupt();
    }
    if (Number.isFinite(options.parserTimeoutMs)) {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("parser_timeout"));
      }, options.parserTimeoutMs);
    }
  });
  try {
    // A detached snapshot prevents parser mutation from corrupting raw fallback.
    const operation = Promise.resolve().then(() =>
      parser(structuredClone(raw))
    );
    const value = await Promise.race([operation, interrupted]);
    validating = true;
    return { payload: jsonSnapshot(value) };
  } catch (error) {
    let parserError = "parser_error";
    if (signal.aborted) {
      parserError = "parser_shutdown";
    } else if (timedOut) {
      parserError = "parser_timeout";
    } else if (validating) {
      parserError = "invalid_parser_output";
    }
    // Omission also excludes exception text: JSON errors can contain body excerpts.
    return {
      parserError,
      ...(options.onParserError === "raw"
        ? {
            payload: jsonSnapshot(raw),
            parserErrorDetails: errorDetails(error),
          }
        : {}),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", interrupt);
  }
}

class DirectionRecording<T extends FetchRecord> {
  readonly done: Promise<void>;
  private readonly body: FetchBodyCapture;
  private readonly parserStop = new AbortController();

  constructor(
    source: Request | Response | undefined,
    metadata: RecordMetadata<T>,
    parser: FetchRecordParser<T> | undefined,
    options: ResolvedFetchRecordOptions,
    emit: (record: ParsedRecord, capture: FetchRecordCapture) => void,
    signal?: AbortSignal,
    reason?: FetchCaptureReason
  ) {
    this.body = new FetchBodyCapture(source, options, signal, reason);
    this.done = this.run(metadata, parser, options, emit);
  }

  private async run(
    metadata: RecordMetadata<T>,
    parser: FetchRecordParser<T> | undefined,
    options: ResolvedFetchRecordOptions,
    emit: (record: ParsedRecord, capture: FetchRecordCapture) => void
  ): Promise<void> {
    try {
      const body = await this.body.result;
      const raw = { ...metadata, ...body, finishedAt: Date.now() } as T;
      const parsed = await parseRecord(
        raw,
        parser,
        options,
        this.parserStop.signal
      );
      emit(parsed, body.capture);
    } catch {
      diagnostic();
    }
  }

  stop(): void {
    this.body.stop("shutdown");
    this.parserStop.abort();
  }
}

export class FetchRecording implements PendingRecording {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private readonly logger: Logger;
  private readonly capturedContext: Context;
  private readonly jobs = new Set<PendingRecording>();
  private networkSettled = false;
  private stopped = false;
  private finished = false;
  private signal?: AbortSignal;
  private readonly options: ResolvedFetchRecordOptions;
  private readonly capacityLimited: boolean;
  private readonly release: () => void;
  private readonly redactUrl?: (url: string) => string;

  constructor(
    options: ResolvedFetchRecordOptions,
    capacityLimited: boolean,
    release: () => void,
    redactUrl?: (url: string) => string
  ) {
    this.options = options;
    this.capacityLimited = capacityLimited;
    this.release = release;
    this.redactUrl = redactUrl;
    this.logger = resolveLogger("@photon-ai/otel", PHOTON_OTEL_VERSION);
    this.capturedContext = context.active();
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    pending.add(this);
  }

  private emit(eventName: string, body: LogBody): void {
    try {
      context.with(suppressTracing(this.capturedContext), () => {
        this.logger.emit({
          eventName,
          body,
          context: this.capturedContext,
          severityNumber: SeverityNumber.DEBUG,
          severityText: "DEBUG",
        });
      });
    } catch {
      diagnostic();
    }
  }

  private record<T extends FetchRecord>(
    direction: "request" | "response",
    source: Request | Response | undefined,
    metadata: RecordMetadata<T>,
    parser: FetchRecordParser<T> | undefined
  ): void {
    const job = context.with(
      suppressTracing(this.capturedContext),
      () =>
        new DirectionRecording(
          source,
          metadata,
          parser,
          this.options,
          (parsed, capture) => {
            this.emit(`photon.fetch.${direction}`, {
              schemaVersion: 1,
              direction,
              startedAt: metadata.startedAt,
              finishedAt: Date.now(),
              capture: { ...capture },
              ...parsed,
            });
          },
          this.signal,
          this.capacityLimited ? "capacity_limit" : undefined
        )
    );
    this.jobs.add(job);
    this.finishJob(job).catch(diagnostic);
  }

  private async finishJob(job: PendingRecording): Promise<void> {
    await job.done;
    this.jobs.delete(job);
    this.finishIfReady();
  }

  request(
    request: Request | undefined,
    fallback: { url: string; method: string; headers: Headers }
  ): void {
    try {
      this.signal = request?.signal;
      this.record<FetchRequestRecord>(
        "request",
        request,
        {
          startedAt: Date.now(),
          url: recordedUrl(request?.url ?? fallback.url, this.redactUrl),
          method: request?.method ?? fallback.method,
          headers: selectHeaders(
            request?.headers ?? fallback.headers,
            this.options.headers
          ),
          options: request ? requestOptions(request, this.redactUrl) : {},
        },
        this.options.parseRequest
      );
    } catch {
      diagnostic();
    }
  }

  response(response: Response): void {
    if (this.stopped) {
      return;
    }
    try {
      this.record<FetchResponseRecord>(
        "response",
        response,
        {
          startedAt: Date.now(),
          url: recordedUrl(response.url, this.redactUrl),
          headers: selectHeaders(response.headers, this.options.headers),
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          redirected: response.redirected,
          type: response.type,
        },
        this.options.parseResponse
      );
    } catch {
      diagnostic();
    } finally {
      this.networkSettled = true;
      this.finishIfReady();
    }
  }

  error(error: unknown): void {
    if (this.stopped) {
      return;
    }
    try {
      this.emit("photon.fetch.error", {
        schemaVersion: 1,
        error: errorDetails(error),
        timestamp: Date.now(),
      });
    } catch {
      diagnostic();
    } finally {
      this.networkSettled = true;
      this.finishIfReady();
    }
  }

  stop(): void {
    this.stopped = true;
    this.networkSettled = true;
    for (const job of this.jobs) {
      job.stop();
    }
    this.finishIfReady();
  }

  private finishIfReady(): void {
    if (this.finished || !this.networkSettled || this.jobs.size > 0) {
      return;
    }
    this.finished = true;
    pending.delete(this);
    this.release();
    this.resolveDone();
  }
}

/** Construct one admission counter per fetch wrapper. */
export function createFetchRecorder(
  options: ResolvedFetchRecordOptions | undefined,
  redactUrl?: (url: string) => string
): () => FetchRecording | undefined {
  let active = 0;
  return () => {
    if (!options) {
      return;
    }
    const capacityLimited = active >= options.maxConcurrentCaptures;
    try {
      const recording = new FetchRecording(
        options,
        capacityLimited,
        () => {
          if (!capacityLimited) {
            active -= 1;
          }
        },
        redactUrl
      );
      if (!capacityLimited) {
        active += 1;
      }
      return recording;
    } catch {
      diagnostic();
      return;
    }
  };
}

/** Drain captures started before this call; the deadline finalizes partial records. */
export async function flushFetchRecords(
  options: { timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = validateFlushTimeout(
    options.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS
  );
  const snapshot = [...pending];
  if (snapshot.length === 0) {
    return;
  }
  const drained = Promise.all(snapshot.map((recording) => recording.done));
  if (!Number.isFinite(timeoutMs)) {
    await drained;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      drained,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    for (const recording of snapshot) {
      recording.stop();
    }
    await drained;
  } finally {
    clearTimeout(timer);
  }
}
