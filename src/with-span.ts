import {
  type Attributes,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import type { LogAttrs } from "./logger";
import { sanitizeErrorMessage } from "./sanitize";
import { PHOTON_OTEL_VERSION } from "./version";

let scopedTracer: Tracer | undefined;

function getTracer(): Tracer {
  if (!scopedTracer) {
    scopedTracer = trace.getTracer("@photon-ai/otel", PHOTON_OTEL_VERSION);
  }
  return scopedTracer;
}

function toAttributes(attrs: LogAttrs): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function withSpan<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
export function withSpan<T>(
  name: string,
  attrs: LogAttrs,
  fn: () => Promise<T> | T
): Promise<T>;
export function withSpan<T>(
  name: string,
  attrsOrFn: LogAttrs | (() => Promise<T> | T),
  maybeFn?: () => Promise<T> | T
): Promise<T> {
  const fn = typeof attrsOrFn === "function" ? attrsOrFn : maybeFn;
  if (!fn) {
    throw new Error("withSpan: function argument is required");
  }
  const attrs = typeof attrsOrFn === "function" ? undefined : attrsOrFn;

  return getTracer().startActiveSpan(name, async (span) => {
    if (attrs) {
      span.setAttributes(toAttributes(attrs));
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      const errorObj = err instanceof Error ? err : undefined;
      span.setAttribute("error.type", errorObj?.constructor.name ?? typeof err);
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
}
