import {
  type Attributes,
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
} from "@opentelemetry/semantic-conventions";
import { sanitizeErrorMessage } from "./sanitize";
import { PHOTON_OTEL_VERSION } from "./version";

export interface InstrumentFetchOptions {
  /**
   * Return `true` to skip instrumenting a request whose absolute URL is passed
   * in. Useful to drop noisy endpoints or URLs that carry secrets in their
   * query string. The request is still performed — only the span is skipped.
   */
  ignore?: (url: string) => boolean;
}

export interface FetchInstrumentation {
  /** Restore the original `globalThis.fetch`. Safe to call more than once. */
  unpatch(): void;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchFn = (input: FetchInput, init?: FetchInit) => Promise<Response>;

/**
 * Stored on the wrapper via the global symbol registry (`Symbol.for`) so the
 * double-wrap guard holds even when two copies of this module load — which can
 * happen because the `bun` export condition serves `src/` while `default`
 * serves `dist/`.
 */
const PATCH_MARKER = Symbol.for("@photon-ai/otel.fetch.original");

const HTTP_ERROR_STATUS_MIN = 400;
const DEFAULT_PORTS: Record<string, number> = { "https:": 443, "http:": 80 };

let scopedTracer: Tracer | undefined;

function getTracer(): Tracer {
  if (!scopedTracer) {
    scopedTracer = trace.getTracer("@photon-ai/otel", PHOTON_OTEL_VERSION);
  }
  return scopedTracer;
}

function setGlobalFetch(fn: FetchFn): void {
  // `preconnect` (Bun) is copied onto wrappers by preserveProps; the cast just
  // tells TypeScript the runtime object satisfies the full `fetch` type.
  globalThis.fetch = fn as typeof fetch;
}

function getPatchOriginal(fn: FetchFn): FetchFn | undefined {
  return (fn as unknown as Record<symbol, FetchFn | undefined>)[PATCH_MARKER];
}

function setPatchOriginal(fn: FetchFn, original: FetchFn): void {
  (fn as unknown as Record<symbol, FetchFn>)[PATCH_MARKER] = original;
}

/** Copy extra own properties (e.g. Bun's `fetch.preconnect`) onto the wrapper. */
function preserveProps(from: FetchFn, to: FetchFn): void {
  for (const key of Object.getOwnPropertyNames(from)) {
    if (key in to) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(from, key);
    if (descriptor) {
      Object.defineProperty(to, key, descriptor);
    }
  }
}

function resolveRequestMeta(
  input: FetchInput,
  init: FetchInit
): { method: string; url: string } {
  if (input instanceof Request) {
    return { method: input.method, url: input.url };
  }
  const url = typeof input === "string" ? input : input.toString();
  return { method: init?.method ?? "GET", url };
}

function resolvePort(parsed: URL): number | undefined {
  if (parsed.port) {
    return Number(parsed.port);
  }
  return DEFAULT_PORTS[parsed.protocol];
}

function toAttributes(attrs: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function fetchAttributes(method: string, url: string): Attributes {
  const attrs: Attributes = {
    [ATTR_HTTP_REQUEST_METHOD]: method,
    [ATTR_URL_FULL]: url,
  };
  try {
    const parsed = new URL(url);
    attrs[ATTR_SERVER_ADDRESS] = parsed.hostname || undefined;
    attrs[ATTR_SERVER_PORT] = resolvePort(parsed);
  } catch {
    // Unparseable URL: leave server.* unset rather than failing the request.
  }
  return toAttributes(attrs);
}

/** Build the outgoing headers and inject the active trace context into them. */
function buildPropagatedHeaders(input: FetchInput, init: FetchInit): Headers {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined
  );
  if (init?.headers) {
    for (const [key, value] of new Headers(init.headers).entries()) {
      headers.set(key, value);
    }
  }
  propagation.inject(context.active(), headers, {
    set: (carrier, key, value) => {
      carrier.set(key, value);
    },
  });
  return headers;
}

function callOriginal(
  original: FetchFn,
  input: FetchInput,
  init: FetchInit,
  headers: Headers
): Promise<Response> {
  if (input instanceof Request) {
    // A consumed Request cannot be safely rebuilt; perform it untouched.
    if (input.bodyUsed) {
      return original(input, init);
    }
    return original(new Request(input, { ...init, headers }));
  }
  return original(input, { ...init, headers });
}

function buildWrappedFetch(
  original: FetchFn,
  options?: InstrumentFetchOptions
): FetchFn {
  return (input, init) => {
    const { method, url } = resolveRequestMeta(input, init);
    if (options?.ignore?.(url)) {
      return original(input, init);
    }
    const name = method.toUpperCase();
    return getTracer().startActiveSpan(
      name,
      { kind: SpanKind.CLIENT },
      async (span) => {
        span.setAttributes(fetchAttributes(name, url));
        try {
          const headers = buildPropagatedHeaders(input, init);
          const response = await callOriginal(original, input, init, headers);
          span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);
          span.setStatus({
            code:
              response.status >= HTTP_ERROR_STATUS_MIN
                ? SpanStatusCode.ERROR
                : SpanStatusCode.OK,
          });
          return response;
        } catch (err) {
          span.recordException(err as Error);
          const errorObj = err instanceof Error ? err : undefined;
          span.setAttribute(
            ATTR_ERROR_TYPE,
            errorObj?.constructor.name ?? typeof err
          );
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorObj
              ? sanitizeErrorMessage(errorObj.message)
              : sanitizeErrorMessage(String(err)),
          });
          throw err;
        } finally {
          span.end();
        }
      }
    );
  };
}

/**
 * Wrap `globalThis.fetch` so every outbound request produces a CLIENT span and
 * carries W3C trace context to the downstream service.
 *
 * On Bun this is the only fetch instrumentation that works: Bun's native fetch
 * emits no `diagnostics_channel` events, so the standard `instrumentation-undici`
 * / `instrumentation-http` (and `opentelemetry-instrumentation-fetch-node`,
 * which is itself diagnostics_channel-based) produce no spans. It works
 * identically on Node, where `globalThis.fetch` is undici-backed.
 *
 * Idempotent: a second call does not stack another wrapper. Returns a handle
 * whose `unpatch()` restores the original fetch.
 */
export function instrumentFetch(
  options?: InstrumentFetchOptions
): FetchInstrumentation {
  const current: FetchFn = globalThis.fetch;
  const existingOriginal = getPatchOriginal(current);
  if (existingOriginal) {
    return {
      unpatch() {
        if (globalThis.fetch === current) {
          setGlobalFetch(existingOriginal);
        }
      },
    };
  }

  const original = current;
  const wrapped = buildWrappedFetch(original, options);
  preserveProps(original, wrapped);
  setPatchOriginal(wrapped, original);
  setGlobalFetch(wrapped);

  return {
    unpatch() {
      if (globalThis.fetch === wrapped) {
        setGlobalFetch(original);
      }
    },
  };
}
