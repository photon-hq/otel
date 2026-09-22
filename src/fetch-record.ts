import { type Context, context, diag } from "@opentelemetry/api";
import {
  type LogBody,
  type Logger,
  SeverityNumber,
} from "@opentelemetry/api-logs";
import { suppressTracing } from "@opentelemetry/core";
import type {
  FetchRecordParser,
  FetchRequestRecord,
  FetchResponseRecord,
  ResolvedFetchRecordOptions,
} from "./fetch-record-options";
import { validateFlushTimeout } from "./record-options";
import {
  DirectionRecording,
  errorDetails,
  type RecordMetadata,
  recordedUrl,
  selectHeaders,
} from "./recording";
import { resolveLogger } from "./scope";
import { PHOTON_OTEL_VERSION } from "./version";

type FetchRecord = FetchRequestRecord | FetchResponseRecord;

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
