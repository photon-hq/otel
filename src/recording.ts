import { diag } from "@opentelemetry/api";
import type { LogBody } from "@opentelemetry/api-logs";
import { FetchBodyCapture } from "./fetch-record-body";
import type {
  RecordBody,
  RecordCapture,
  RecordCaptureReason,
  RecordParser,
  ResolvedRecordOptions,
} from "./record-options";
import { sanitizeErrorMessage } from "./sanitize";

export interface BodyRecord {
  body: RecordBody | null;
  capture: RecordCapture;
  finishedAt: number;
}
export type RecordMetadata<T> = Omit<T, "body" | "capture" | "finishedAt">;
export type RecordingPolicy = Omit<
  ResolvedRecordOptions<unknown, unknown>,
  "parseRequest" | "parseResponse"
>;

export function diagnostic(): void {
  try {
    diag.warn("[@photon-ai/otel] Payload record could not be emitted");
  } catch {
    return;
  }
}

export function selectHeaders(
  headers: Headers,
  selection: RecordingPolicy["headers"]
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

export function recordedUrl(
  url: string,
  redactUrl?: (url: string) => string
): string {
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

export function jsonText(value: unknown): string {
  assertJson(value);
  return JSON.stringify(value);
}

export function jsonSnapshot(value: unknown): LogBody {
  return JSON.parse(jsonText(value)) as LogBody;
}

interface ParsedRecord {
  parserError?: string;
  parserErrorDetails?: { name: string; message: string; stack?: string };
  payload?: LogBody;
}

export function errorDetails(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeErrorMessage(error.message),
      ...(error.stack ? { stack: sanitizeErrorMessage(error.stack) } : {}),
    };
  }
  return { name: typeof error, message: sanitizeErrorMessage(String(error)) };
}

async function parseRecord<T extends BodyRecord>(
  raw: T,
  parser: RecordParser<T> | undefined,
  options: RecordingPolicy,
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

export class DirectionRecording<T extends BodyRecord> {
  readonly done: Promise<void>;
  private readonly body: FetchBodyCapture;
  private readonly parserStop = new AbortController();

  constructor(
    source: Request | Response | undefined,
    metadata: RecordMetadata<T>,
    parser: RecordParser<T> | undefined,
    options: RecordingPolicy,
    emit: (record: ParsedRecord, capture: RecordCapture) => void,
    signal?: AbortSignal,
    reason?: RecordCaptureReason
  ) {
    this.body = new FetchBodyCapture(source, options, signal, reason);
    this.done = this.run(metadata, parser, options, emit);
  }

  private async run(
    metadata: RecordMetadata<T>,
    parser: RecordParser<T> | undefined,
    options: RecordingPolicy,
    emit: (record: ParsedRecord, capture: RecordCapture) => void
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
