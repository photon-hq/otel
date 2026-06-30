import {
  type Attributes,
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
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
import { resolveTracer } from "./scope";
import { PHOTON_OTEL_VERSION } from "./version";

export interface FetchSpanOptions {
  /**
   * Static attributes merged into every CLIENT span this instrumentation
   * produces. Handy for tagging an SDK's traffic, e.g. `{ "peer.service":
   * "openai" }`, so spans from different instrumented fetches stay
   * distinguishable.
   */
  attributes?: Attributes;
  /**
   * Return `true` to skip instrumenting a request whose absolute URL is passed
   * in. Useful to drop noisy endpoints or URLs that carry secrets in their
   * query string. The request is still performed — only the span is skipped.
   */
  ignore?: (url: string) => boolean;
}

export interface InstrumentFetchOptions extends FetchSpanOptions {
  /**
   * Which fetch-instrumentation strategy `setupOtel()` should use:
   * - `"auto"` (default): the official `@opentelemetry/instrumentation-undici`
   *   on Node (richer HTTP-client semantic conventions, captures all undici
   *   traffic, no global monkey-patch), and the `globalThis.fetch` wrap on Bun
   *   (the only thing that works there).
   * - `"global"`: always wrap `globalThis.fetch` on both runtimes. Produces
   *   identical spans everywhere and keeps the built-in PII scrubbing of error
   *   messages, at the cost of the richer Node attributes. Use this when you
   *   want Bun and Node telemetry to match exactly.
   *
   * Only consulted by `setupOtel()`. Calling `instrumentFetch()` directly always
   * performs a global wrap regardless of this field.
   */
  mode?: "auto" | "global";
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
    // A consumed Request's body can't be rebuilt, but its headers stay mutable
    // (verified on both Bun and Node) — inject the propagated context in place
    // so trace headers still flow without reconstructing the unusable Request.
    if (input.bodyUsed) {
      for (const [key, value] of headers.entries()) {
        input.headers.set(key, value);
      }
      return original(input, init);
    }
    return original(new Request(input, { ...init, headers }));
  }
  return original(input, { ...init, headers });
}

function buildWrappedFetch(
  original: FetchFn,
  options?: FetchSpanOptions
): FetchFn {
  const staticAttributes = options?.attributes;
  return (input, init) => {
    const { method, url } = resolveRequestMeta(input, init);
    if (options?.ignore?.(url)) {
      return original(input, init);
    }
    const name = method.toUpperCase();
    return resolveTracer(
      "@photon-ai/otel",
      PHOTON_OTEL_VERSION
    ).startActiveSpan(name, { kind: SpanKind.CLIENT }, async (span) => {
      if (staticAttributes) {
        span.setAttributes(staticAttributes);
      }
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
    });
  };
}

/**
 * Wrap a single fetch function — not `globalThis.fetch` — so requests made
 * through the RETURNED fetch produce a CLIENT span and carry W3C trace context
 * to the downstream service.
 *
 * Built for SDKs that accept a `fetch` option, e.g.
 * `new OpenAI({ fetch: createInstrumentedFetch() })`. Unlike `instrumentFetch`,
 * it never mutates the global and has no lifecycle to unpatch — it just returns
 * a new fetch you pass where you need it.
 *
 * `baseFetch` defaults to the current `globalThis.fetch`, read at call time.
 * Idempotent: passing an already-instrumented fetch returns it unchanged.
 *
 * Always uses the global-wrap technique (the native undici instrumentation
 * cannot target a single instance), so it behaves identically on Bun and Node.
 * On Node, if `setupOtel`'s global fetch instrumentation is also active, the
 * SDK's request is captured twice — disable it (`instrumentFetch: false`) for
 * paths you instrument per-instance.
 */
export function createInstrumentedFetch(
  baseFetch: typeof fetch = globalThis.fetch,
  options?: FetchSpanOptions
): typeof fetch {
  if (getPatchOriginal(baseFetch)) {
    return baseFetch;
  }
  const wrapped = buildWrappedFetch(baseFetch, options);
  preserveProps(baseFetch, wrapped);
  setPatchOriginal(wrapped, baseFetch);
  return wrapped as typeof fetch;
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
  const current = globalThis.fetch;
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
  const wrapped = createInstrumentedFetch(original, options);
  setGlobalFetch(wrapped);

  return {
    unpatch() {
      if (globalThis.fetch === wrapped) {
        setGlobalFetch(original);
      }
    },
  };
}
