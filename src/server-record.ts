import { randomUUID } from "node:crypto";
import { type Context, context } from "@opentelemetry/api";
import {
  type LogBody,
  type Logger,
  SeverityNumber,
} from "@opentelemetry/api-logs";
import { suppressTracing } from "@opentelemetry/core";
import type {
  FetchRequestRecord,
  FetchResponseRecord,
} from "./fetch-record-options";
import {
  DEFAULT_FLUSH_TIMEOUT_MS,
  type RecordCaptureReason,
  type RecordOptions,
  type RecordParser,
  resolveRecordOptions,
  validateFlushTimeout,
} from "./record-options";
import {
  type BodyRecord,
  DirectionRecording,
  diagnostic,
  errorDetails,
  jsonText,
  type RecordingPolicy,
  type RecordMetadata,
  recordedUrl,
  selectHeaders,
} from "./recording";
import { resolveLogger } from "./scope";
import { PHOTON_OTEL_VERSION } from "./version";

export type HttpServerRecordOptions = RecordOptions<
  FetchRequestRecord,
  FetchResponseRecord
>;

export interface ServerRecordContext {
  context?: Context;
  requestId?: string;
}

export interface HttpServerRecording {
  readonly done: Promise<void>;
  error(error: unknown): void;
  response(response: Response): void;
}

export interface RpcRequestRecord extends BodyRecord {
  headers: Record<string, string[]>;
  method: string;
  service: string;
  startedAt: number;
  system: "connectrpc" | "grpc";
}

export interface RpcResponseRecord extends RpcRequestRecord {
  code: string;
}

export type RpcServerRecordOptions = RecordOptions<
  RpcRequestRecord,
  RpcResponseRecord
>;

export interface RpcServerRequest extends ServerRecordContext {
  headers?: Headers;
  message: () => unknown;
  method: string;
  service: string;
  signal?: AbortSignal;
  system?: "connectrpc" | "grpc";
}

export interface RpcServerRecording {
  readonly done: Promise<void>;
  error(error: unknown, code?: string): void;
  response(message: () => unknown, options?: { headers?: Headers }): void;
}

interface PendingRecord {
  done: Promise<void>;
  stop(): void;
}

const REGISTRY = Symbol.for("@photon-ai/otel.server.records");
const registryHost = globalThis as unknown as Record<
  symbol,
  Set<PendingRecord> | undefined
>;
const pending = registryHost[REGISTRY] ?? new Set<PendingRecord>();
registryHost[REGISTRY] = pending;

class ServerRecording implements PendingRecord {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private readonly logger: Logger;
  private readonly capturedContext: Context;
  private readonly recordId = randomUUID();
  private readonly startedAt = Date.now();
  private readonly jobs = new Set<PendingRecord>();
  private terminal = false;
  private completedAt?: number;
  private finished = false;
  private readonly prefix: string;
  private readonly operation: Record<string, string>;
  private readonly options: RecordingPolicy;
  private readonly capacityLimited: boolean;
  private readonly release: () => void;
  private readonly requestId?: string;
  private readonly signal?: AbortSignal;
  private readonly abort = (): void =>
    this.fail(this.signal?.reason ?? new Error("Request aborted"), "CANCELLED");

  constructor(
    prefix: string,
    operation: Record<string, string>,
    options: RecordingPolicy,
    capacityLimited: boolean,
    release: () => void,
    recordContext: ServerRecordContext,
    signal?: AbortSignal
  ) {
    this.prefix = prefix;
    this.operation = operation;
    this.options = options;
    this.capacityLimited = capacityLimited;
    this.release = release;
    this.requestId = recordContext.requestId;
    this.signal = signal;
    this.logger = resolveLogger("@photon-ai/otel", PHOTON_OTEL_VERSION);
    this.capturedContext = recordContext.context ?? context.active();
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    pending.add(this);
  }

  watchAbort(): void {
    this.signal?.addEventListener("abort", this.abort, { once: true });
    if (this.signal?.aborted) {
      this.abort();
    }
  }

  private emit(direction: string, body: Record<string, LogBody>): void {
    try {
      this.logger.emit({
        eventName: `${this.prefix}.${direction}`,
        body: {
          schemaVersion: 1,
          recordId: this.recordId,
          operation: this.operation,
          ...(this.requestId ? { requestId: this.requestId } : {}),
          startedAt: this.startedAt,
          finishedAt: Date.now(),
          ...(this.completedAt === undefined
            ? {}
            : {
                completedAt: this.completedAt,
                durationMs: this.completedAt - this.startedAt,
              }),
          ...body,
        },
        attributes: { "record.id": this.recordId, ...this.operation },
        context: this.capturedContext,
        severityNumber: SeverityNumber.DEBUG,
        severityText: "DEBUG",
      });
    } catch {
      diagnostic();
    }
  }

  capture<T extends BodyRecord>(
    direction: "request" | "response",
    source: Request | Response | (() => unknown),
    metadata: RecordMetadata<T>,
    parser?: RecordParser<T>
  ): void {
    try {
      let body: Request | Response | undefined;
      let reason: RecordCaptureReason | undefined;
      if (this.capacityLimited) {
        reason = "capacity_limit";
      } else if (this.options.maxBodyBytes === 0) {
        reason = "size_limit";
      }
      let serializationFailed = false;
      if (!reason) {
        if (typeof source === "function") {
          try {
            body = context.with(
              suppressTracing(this.capturedContext),
              () => new Response(jsonText(source()))
            );
          } catch {
            serializationFailed = true;
          }
        } else {
          body = source;
        }
      }
      const job = context.with(
        suppressTracing(this.capturedContext),
        () =>
          new DirectionRecording<T>(
            body,
            metadata,
            parser,
            this.options,
            (parsed, capture) =>
              this.emit(direction, {
                direction,
                capture: { ...capture },
                ...parsed,
              }),
            this.signal,
            serializationFailed ? "serialization_error" : reason
          )
      );
      this.jobs.add(job);
      this.finishJob(job).catch(diagnostic);
    } catch {
      diagnostic();
    }
  }

  private async finishJob(job: PendingRecord): Promise<void> {
    await job.done;
    this.jobs.delete(job);
    this.finishIfReady();
  }

  complete(record: () => void): void {
    if (this.terminal) {
      return;
    }
    this.terminal = true;
    this.completedAt = Date.now();
    this.signal?.removeEventListener("abort", this.abort);
    try {
      record();
    } catch {
      diagnostic();
    } finally {
      this.finishIfReady();
    }
  }

  fail(error: unknown, code?: string): void {
    this.complete(() =>
      this.emit("error", {
        error: errorDetails(error),
        ...(code ? { code } : {}),
      })
    );
  }

  stop(): void {
    this.complete(() =>
      this.emit("incomplete", {
        capture: { complete: false, capturedBytes: 0, reason: "shutdown" },
      })
    );
    for (const job of this.jobs) {
      job.stop();
    }
    this.finishIfReady();
  }

  private finishIfReady(): void {
    if (this.finished || !this.terminal || this.jobs.size > 0) {
      return;
    }
    this.finished = true;
    pending.delete(this);
    this.release();
    this.resolveDone();
  }
}

function recordingFactory(prefix: string, policy: RecordingPolicy) {
  let active = 0;
  return (
    operation: Record<string, string>,
    recordContext: ServerRecordContext,
    signal?: AbortSignal
  ) => {
    const capacityLimited = active >= policy.maxConcurrentCaptures;
    if (!capacityLimited) {
      active += 1;
    }
    const release = () => {
      if (!capacityLimited) {
        active -= 1;
      }
    };
    try {
      return new ServerRecording(
        prefix,
        operation,
        policy,
        capacityLimited,
        release,
        recordContext,
        signal
      );
    } catch {
      release();
      diagnostic();
      return;
    }
  };
}

const unavailableRecording = {
  done: Promise.resolve(),
  error: () => undefined,
  response: () => undefined,
};

export function createHttpServerRecorder(options: {
  record: HttpServerRecordOptions;
  redactUrl?: (url: string) => string;
}): (
  request: Request,
  recordContext?: ServerRecordContext
) => HttpServerRecording {
  const policy = resolveRecordOptions(options.record);
  if (!policy) {
    throw new TypeError("Server recording requires an explicit record preset");
  }
  const start = recordingFactory("photon.http.server", policy);
  return (request, recordContext = {}) => {
    const url = recordedUrl(request.url, options.redactUrl);
    const exchange = start(
      { protocol: "http", method: request.method, url },
      recordContext,
      request.signal
    );
    if (!exchange) {
      return unavailableRecording;
    }
    exchange.capture<FetchRequestRecord>(
      "request",
      request,
      {
        url,
        method: request.method,
        headers: selectHeaders(request.headers, policy.headers),
        options: {},
        startedAt: Date.now(),
      },
      policy.parseRequest
    );
    exchange.watchAbort();
    return {
      done: exchange.done,
      error: (error) => exchange.fail(error),
      response: (response) =>
        exchange.complete(() =>
          exchange.capture<FetchResponseRecord>(
            "response",
            response,
            {
              url: response.url
                ? recordedUrl(response.url, options.redactUrl)
                : url,
              headers: selectHeaders(response.headers, policy.headers),
              status: response.status,
              statusText: response.statusText,
              ok: response.ok,
              redirected: response.redirected,
              type: response.type,
              startedAt: Date.now(),
            },
            policy.parseResponse
          )
        ),
    };
  };
}

export function createRpcServerRecorder(options: {
  record: RpcServerRecordOptions;
}): (request: RpcServerRequest) => RpcServerRecording {
  const policy = resolveRecordOptions(options.record);
  if (!policy) {
    throw new TypeError("Server recording requires an explicit record preset");
  }
  const start = recordingFactory("photon.rpc.server", policy);
  return (request) => {
    const { method, service } = request;
    const system = request.system ?? "connectrpc";
    const exchange = start(
      { protocol: system, service, method },
      request,
      request.signal
    );
    if (!exchange) {
      return unavailableRecording;
    }
    exchange.capture<RpcRequestRecord>(
      "request",
      request.message,
      {
        method,
        service,
        system,
        headers: selectHeaders(
          request.headers ?? new Headers(),
          policy.headers
        ),
        startedAt: Date.now(),
      },
      policy.parseRequest
    );
    exchange.watchAbort();
    return {
      done: exchange.done,
      error: (error, code = "UNKNOWN") => exchange.fail(error, code),
      response: (message, responseOptions = {}) =>
        exchange.complete(() =>
          exchange.capture<RpcResponseRecord>(
            "response",
            message,
            {
              method,
              service,
              system,
              code: "OK",
              headers: selectHeaders(
                responseOptions.headers ?? new Headers(),
                policy.headers
              ),
              startedAt: Date.now(),
            },
            policy.parseResponse
          )
        ),
    };
  };
}

export async function flushServerRecords(
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
