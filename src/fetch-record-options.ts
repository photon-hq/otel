/** Lossless representation of the bytes exposed by Fetch, without content parsing. */
export interface FetchRecordBody {
  byteLength: number;
  data: string;
  encoding: "utf8" | "base64";
}

export type FetchCaptureReason =
  | "size_limit"
  | "timeout"
  | "capacity_limit"
  | "abort"
  | "unavailable_body"
  | "read_failure"
  | "shutdown";

export interface FetchRecordCapture {
  capturedBytes: number;
  complete: boolean;
  reason?: FetchCaptureReason;
}

export interface FetchRequestRecord {
  body: FetchRecordBody | null;
  capture: FetchRecordCapture;
  /** Unix timestamps in milliseconds. */
  finishedAt: number;
  headers: Record<string, string[]>;
  method: string;
  options: Record<string, string | boolean>;
  startedAt: number;
  url: string;
}

export interface FetchResponseRecord {
  body: FetchRecordBody | null;
  capture: FetchRecordCapture;
  finishedAt: number;
  headers: Record<string, string[]>;
  ok: boolean;
  redirected: boolean;
  startedAt: number;
  status: number;
  statusText: string;
  type: string;
  url: string;
}

/** Return a JSON-compatible replacement payload. Only the custom preset supports parsers. */
export type FetchRecordParser<T> = (
  record: Readonly<T>
) => unknown | Promise<unknown>;

interface FetchCaptureOverrides {
  /** Per-direction body deadline in milliseconds. Infinity removes the limit. */
  bodyTimeoutMs?: number;
  /** Case-insensitive names, or an explicit opt-in to all headers. */
  headers?: "all" | readonly string[];
  /** Per-direction byte limit. Zero captures metadata only; Infinity is unlimited. */
  maxBodyBytes?: number;
  /** Per-wrapper limit on fetch exchanges undergoing capture. */
  maxConcurrentCaptures?: number;
}

export type FetchRecordOptions = FetchCaptureOverrides &
  (
    | {
        onParserError?: never;
        parseRequest?: never;
        parseResponse?: never;
        parserTimeoutMs?: never;
        preset: "bounded" | "full";
      }
    | {
        /** Defaults to raw fallback. Use omit when a parser removes sensitive data. */
        onParserError?: "raw" | "omit";
        parseRequest?: FetchRecordParser<FetchRequestRecord>;
        parseResponse?: FetchRecordParser<FetchResponseRecord>;
        parserTimeoutMs?: number;
        /** Starts with full capture defaults; no parser runs unless provided. */
        preset: "custom";
      }
  );

export interface ResolvedFetchRecordOptions {
  bodyTimeoutMs: number;
  headers: "all" | ReadonlySet<string>;
  maxBodyBytes: number;
  maxConcurrentCaptures: number;
  onParserError: "raw" | "omit";
  parseRequest?: FetchRecordParser<FetchRequestRecord>;
  parseResponse?: FetchRecordParser<FetchResponseRecord>;
  parserTimeoutMs: number;
}

const BOUNDED_BODY_BYTES = 1024 * 1024;
const BOUNDED_TIMEOUT_MS = 30_000;
const BOUNDED_CONCURRENCY = 32;
const PARSER_TIMEOUT_MS = 5000;
const MAX_TIMER_MS = 2_147_483_647;
const BOUNDED_HEADERS = [
  "accept",
  "content-type",
  "content-length",
  "x-request-id",
  "traceparent",
  "retry-after",
];
const PARSER_OPTIONS = [
  "parseRequest",
  "parseResponse",
  "parserTimeoutMs",
  "onParserError",
] as const;

function limit(value: number, name: string, timer = false): number {
  if (value === Number.POSITIVE_INFINITY) {
    return value;
  }
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (timer && value > MAX_TIMER_MS)
  ) {
    throw new TypeError(
      `record.${name} must be a nonnegative integer or Infinity`
    );
  }
  return value;
}

function resolveHeaders(
  headers: FetchCaptureOverrides["headers"],
  bounded: boolean
): "all" | ReadonlySet<string> {
  const selected = headers ?? (bounded ? BOUNDED_HEADERS : "all");
  if (selected === "all") {
    return selected;
  }
  if (!Array.isArray(selected)) {
    throw new TypeError(
      'record.headers must be "all" or an array of header names'
    );
  }
  const normalized = new Set<string>();
  for (const name of selected) {
    if (typeof name !== "string") {
      throw new TypeError("record.headers must contain strings");
    }
    new Headers([[name, "validate"]]);
    normalized.add(name.toLowerCase());
  }
  return normalized;
}

function validateParsers(options: FetchRecordOptions): void {
  if (options.preset !== "custom") {
    for (const key of PARSER_OPTIONS) {
      if (key in options) {
        throw new TypeError(`record.${key} requires the custom preset`);
      }
    }
    return;
  }
  for (const key of ["parseRequest", "parseResponse"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "function") {
      throw new TypeError(`record.${key} must be a function`);
    }
  }
  if (
    options.onParserError !== undefined &&
    options.onParserError !== "raw" &&
    options.onParserError !== "omit"
  ) {
    throw new TypeError('record.onParserError must be "raw" or "omit"');
  }
}

export function resolveFetchRecordOptions(
  options: false | FetchRecordOptions | undefined
): ResolvedFetchRecordOptions | undefined {
  if (options === undefined || options === false) {
    return;
  }
  if (
    typeof options !== "object" ||
    options === null ||
    !["bounded", "full", "custom"].includes(options.preset)
  ) {
    throw new TypeError(
      'record requires preset: "bounded", "full", or "custom"'
    );
  }
  validateParsers(options);
  const bounded = options.preset === "bounded";
  return {
    bodyTimeoutMs: limit(
      options.bodyTimeoutMs ??
        (bounded ? BOUNDED_TIMEOUT_MS : Number.POSITIVE_INFINITY),
      "bodyTimeoutMs",
      true
    ),
    headers: resolveHeaders(options.headers, bounded),
    maxBodyBytes: limit(
      options.maxBodyBytes ??
        (bounded ? BOUNDED_BODY_BYTES : Number.POSITIVE_INFINITY),
      "maxBodyBytes"
    ),
    maxConcurrentCaptures: limit(
      options.maxConcurrentCaptures ??
        (bounded ? BOUNDED_CONCURRENCY : Number.POSITIVE_INFINITY),
      "maxConcurrentCaptures"
    ),
    onParserError: options.onParserError ?? "raw",
    parseRequest: options.parseRequest,
    parseResponse: options.parseResponse,
    parserTimeoutMs: limit(
      options.parserTimeoutMs ?? PARSER_TIMEOUT_MS,
      "parserTimeoutMs",
      true
    ),
  };
}

export function validateFlushTimeout(timeoutMs: number): number {
  return limit(timeoutMs, "flush.timeoutMs", true);
}
