import {
  type Attributes,
  type Context,
  createContextKey,
  defaultTextMapGetter,
  defaultTextMapSetter,
  diag,
  INVALID_SPAN_CONTEXT,
  propagation as otelPropagation,
  ROOT_CONTEXT,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { Logger, LogRecord } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  type Resource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resolveOtlpEndpoint } from "./otlp-config";
import {
  type ServiceResourceOptions,
  serviceResourceAttributes,
} from "./service-resource";

const INSTRUMENTATION_SCOPE = "@photon-ai/otel";
const BAGGAGE_KEY = "baggage";
const TRACEPARENT_KEY = "traceparent";
const TRACESTATE_KEY = "tracestate";
const STANDARD_PROPAGATION_HEADERS = new Set([
  BAGGAGE_KEY,
  TRACEPARENT_KEY,
  TRACESTATE_KEY,
]);

// biome-ignore assist/source/useSortedInterfaceMembers: required options precede optional configuration.
export interface IsolatedOtelOptions extends ServiceResourceOptions {
  /**
   * OTLP/HTTP base endpoint. `/v1/traces` and `/v1/logs` are appended by the
   * runtime. Standard main OTel environment variables do not override it.
   */
  endpoint: string;
  /** Private trace carrier; standard propagation header names are rejected. */
  traceparentHeader: string;
  /** Optional private W3C Baggage carrier; standard headers are untouched. */
  baggageHeader?: string;
  /** Optional OTLP transport headers, typically used for Collector auth. */
  headers?: Record<string, string>;
}

/** Transport-only options; the Resource is supplied separately. */
type IsolatedOtelTransport = Pick<
  IsolatedOtelOptions,
  "baggageHeader" | "endpoint" | "headers" | "traceparentHeader"
>;

// biome-ignore assist/source/useSortedInterfaceMembers: the required type precedes the optional public message.
export interface IsolatedOtelErrorDetails {
  /** Stable, low-cardinality error classification exported as `error.type`. */
  readonly type: string;
  /** Optional caller-curated message that is safe for the isolated backend. */
  readonly message?: string;
}

export interface IsolatedOtelHandle {
  createLogger(
    name: string,
    version?: string
  ): {
    emit: (record: Omit<LogRecord, "context">) => void;
  };
  /** True only for a recording local Span, not a remote or suppressed parent. */
  hasActiveSpan(): boolean;
  readonly propagation: {
    /** Capture the current context so delayed iterators can re-enter it. */
    capture: () => Context;
    /** Extract a valid parent from this runtime's configured carrier header. */
    extract: (headers: Headers) => Context | undefined;
    /** Inject the current or explicitly captured private context. */
    inject: (headers: Headers, captured?: Context) => void;
    /** Run a callback in this runtime's isolated async context. */
    run: <T>(captured: Context, fn: () => T) => T;
  };
  /** Explicitly record caller-curated error details on the active local Span. */
  recordError(details: IsolatedOtelErrorDetails): void;
  shutdown(): Promise<void>;
  /** Run a callback with a Span active only in this runtime's private Context. */
  withActiveSpan<T>(
    name: string,
    options: SpanOptions & { parentContext?: Context },
    fn: (span: Span) => Promise<T> | T
  ): Promise<T>;
  withSpan<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  withSpan<T>(
    name: string,
    attributes: Attributes,
    fn: () => Promise<T> | T
  ): Promise<T>;
}

const reportDiagnostic = (message: string, error?: unknown): void => {
  try {
    if (error === undefined) {
      diag.warn(`[${INSTRUMENTATION_SCOPE}] ${message}`);
      return;
    }
    diag.warn(`[${INSTRUMENTATION_SCOPE}] ${message}`, error);
  } catch {
    // Diagnostic reporting is itself fail-open.
  }
};

const normalizeErrorDetails = (
  value: unknown
): IsolatedOtelErrorDetails | undefined => {
  try {
    if (
      value instanceof Error ||
      typeof value !== "object" ||
      value === null ||
      !("type" in value)
    ) {
      return;
    }

    const type = value.type;
    if (typeof type !== "string" || type.trim().length === 0) {
      return;
    }

    const message = "message" in value ? value.message : undefined;
    if (!(message === undefined || typeof message === "string")) {
      return;
    }

    return {
      ...(message === undefined ? {} : { message }),
      type,
    };
  } catch {
    return;
  }
};

/**
 * Internal constructor exported for deterministic in-memory tests. It is not
 * re-exported from the package entry point.
 */
export const createIsolatedOtelRuntime = (
  options: IsolatedOtelTransport,
  resource: Resource,
  processors?: {
    readonly logRecordProcessors?: readonly LogRecordProcessor[];
    readonly spanProcessors?: readonly SpanProcessor[];
  }
): IsolatedOtelHandle => {
  const endpoint = options.endpoint.trim();
  let endpointProtocol: string;
  try {
    endpointProtocol = new URL(endpoint).protocol;
  } catch {
    throw new TypeError("createIsolatedOtel: endpoint must be a valid URL");
  }
  if (!(endpointProtocol === "http:" || endpointProtocol === "https:")) {
    throw new TypeError("createIsolatedOtel: endpoint must use http or https");
  }
  const validateHeaderName = (
    headerName: string,
    optionName: "baggageHeader" | "traceparentHeader"
  ): void => {
    try {
      if (!headerName) {
        throw new TypeError(`${optionName} is empty`);
      }
      new Headers().set(headerName, "validate");
    } catch {
      throw new TypeError(
        `createIsolatedOtel: ${optionName} must be a valid HTTP header name`
      );
    }
  };

  const traceparentHeader = options.traceparentHeader;
  validateHeaderName(traceparentHeader, "traceparentHeader");
  const normalizedTraceparentHeader = traceparentHeader.toLowerCase();
  if (STANDARD_PROPAGATION_HEADERS.has(normalizedTraceparentHeader)) {
    throw new TypeError(
      "createIsolatedOtel: traceparentHeader must not be traceparent, tracestate, or baggage"
    );
  }

  const baggageHeader = options.baggageHeader;
  if (baggageHeader !== undefined) {
    validateHeaderName(baggageHeader, "baggageHeader");
    const normalizedBaggageHeader = baggageHeader.toLowerCase();
    if (STANDARD_PROPAGATION_HEADERS.has(normalizedBaggageHeader)) {
      throw new TypeError(
        "createIsolatedOtel: baggageHeader must not be traceparent, tracestate, or baggage"
      );
    }
    if (normalizedBaggageHeader === normalizedTraceparentHeader) {
      throw new TypeError(
        "createIsolatedOtel: baggageHeader must differ from traceparentHeader"
      );
    }
  }
  const headers = options.headers ? { ...options.headers } : undefined;
  const traceEndpoint = resolveOtlpEndpoint("traces", endpoint, {});
  const logEndpoint = resolveOtlpEndpoint("logs", endpoint, {});

  const spanProcessors = processors?.spanProcessors
    ? [...processors.spanProcessors]
    : [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: traceEndpoint, headers })
        ),
      ];
  const logRecordProcessors = processors?.logRecordProcessors
    ? [...processors.logRecordProcessors]
    : [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({ url: logEndpoint, headers })
        ),
      ];

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors,
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: logRecordProcessors,
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const localSpanKey = createContextKey("@photon-ai/isolated-otel.local-span");
  const baggagePropagator = new W3CBaggagePropagator();
  const traceContextPropagator = new W3CTraceContextPropagator();
  const tracer = tracerProvider.getTracer(INSTRUMENTATION_SCOPE);
  let shutdownPromise: Promise<void> | undefined;

  const propagation: IsolatedOtelHandle["propagation"] = {
    capture: () => contextManager.active(),
    extract: (headersObject) => {
      let extracted = ROOT_CONTEXT;
      let foundContext = false;

      const traceValue = headersObject.get(traceparentHeader);
      if (traceValue) {
        try {
          const traceExtracted = traceContextPropagator.extract(
            extracted,
            { [TRACEPARENT_KEY]: traceValue },
            defaultTextMapGetter
          );
          const spanContext = trace.getSpanContext(traceExtracted);
          if (spanContext && trace.isSpanContextValid(spanContext)) {
            extracted = traceExtracted;
            foundContext = true;
          } else {
            reportDiagnostic("ignored invalid isolated trace header");
          }
        } catch (error) {
          reportDiagnostic("ignored invalid isolated trace header", error);
        }
      }

      const baggageValue = baggageHeader
        ? headersObject.get(baggageHeader)
        : undefined;
      if (baggageValue) {
        try {
          const baggageExtracted = baggagePropagator.extract(
            extracted,
            { [BAGGAGE_KEY]: baggageValue },
            defaultTextMapGetter
          );
          const baggage = otelPropagation.getBaggage(baggageExtracted);
          if (baggage && baggage.getAllEntries().length > 0) {
            extracted = baggageExtracted;
            foundContext = true;
          } else {
            reportDiagnostic("ignored invalid isolated baggage header");
          }
        } catch (error) {
          reportDiagnostic("ignored invalid isolated baggage header", error);
        }
      }

      return foundContext ? extracted : undefined;
    },
    inject: (headersObject, captured) => {
      const active = captured ?? contextManager.active();
      try {
        headersObject.delete(traceparentHeader);
        const carrier: Record<string, string> = {};
        traceContextPropagator.inject(active, carrier, defaultTextMapSetter);
        const value = carrier[TRACEPARENT_KEY];
        if (value) {
          headersObject.set(traceparentHeader, value);
        }
      } catch (error) {
        reportDiagnostic("failed to inject isolated trace header", error);
      }

      if (baggageHeader) {
        try {
          headersObject.delete(baggageHeader);
          const carrier: Record<string, string> = {};
          baggagePropagator.inject(active, carrier, defaultTextMapSetter);
          const value = carrier[BAGGAGE_KEY];
          if (value) {
            headersObject.set(baggageHeader, value);
          }
        } catch (error) {
          reportDiagnostic("failed to inject isolated baggage header", error);
        }
      }
    },
    run: (captured, fn) => contextManager.with(captured, fn),
  };

  const withActiveSpan: IsolatedOtelHandle["withActiveSpan"] = async (
    name,
    options,
    fn
  ) => {
    const { parentContext, ...spanOptions } = options;
    const parent = parentContext ?? contextManager.active();
    let span: Span;
    try {
      span = tracer.startSpan(name, spanOptions, parent);
    } catch (error) {
      reportDiagnostic("failed to start Span", error);
      return await fn(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
    }

    const spanContext = trace.setSpan(parent, span);
    const active = span.isRecording()
      ? spanContext.setValue(localSpanKey, span)
      : spanContext;
    return await contextManager.with(active, async () => {
      try {
        return await fn(span);
      } catch (error) {
        try {
          span.setStatus({ code: SpanStatusCode.ERROR });
        } catch (telemetryError) {
          reportDiagnostic("failed to set Span error status", telemetryError);
        }
        throw error;
      } finally {
        try {
          span.end();
        } catch (error) {
          reportDiagnostic("failed to end Span", error);
        }
      }
    });
  };

  const withSpan = <T>(
    name: string,
    attributesOrFn: Attributes | (() => Promise<T> | T),
    maybeFn?: () => Promise<T> | T
  ): Promise<T> => {
    const fn = typeof attributesOrFn === "function" ? attributesOrFn : maybeFn;
    if (!fn) {
      throw new Error("withSpan: function argument is required");
    }
    const attributes =
      typeof attributesOrFn === "function" ? undefined : attributesOrFn;
    return withActiveSpan(name, { attributes }, () => fn());
  };

  return {
    createLogger(name, version) {
      const logger: Logger = loggerProvider.getLogger(name, version);
      return {
        emit(record) {
          try {
            logger.emit({ ...record, context: contextManager.active() });
          } catch (error) {
            reportDiagnostic("failed to emit LogRecord", error);
          }
        },
      };
    },
    hasActiveSpan: () =>
      contextManager.active().getValue(localSpanKey) !== undefined,
    propagation,
    recordError(details) {
      const span = contextManager.active().getValue(localSpanKey) as
        | Span
        | undefined;
      if (!span?.isRecording()) {
        reportDiagnostic("ignored recordError outside a local recording Span");
        return;
      }

      try {
        span.setStatus({ code: SpanStatusCode.ERROR });
      } catch (telemetryError) {
        reportDiagnostic("failed to set Span error status", telemetryError);
      }

      const normalizedDetails = normalizeErrorDetails(details);
      if (!normalizedDetails) {
        reportDiagnostic("ignored recordError with invalid error details");
        return;
      }

      try {
        span.recordException({
          ...(normalizedDetails.message === undefined
            ? {}
            : { message: normalizedDetails.message }),
          name: normalizedDetails.type,
        });
      } catch (telemetryError) {
        reportDiagnostic("failed to record Span exception", telemetryError);
      }
      try {
        span.setAttribute("error.type", normalizedDetails.type);
      } catch (telemetryError) {
        reportDiagnostic("failed to set Span error type", telemetryError);
      }
    },
    shutdown() {
      if (!shutdownPromise) {
        shutdownPromise = (async () => {
          contextManager.disable();
          await Promise.all([
            tracerProvider.shutdown(),
            loggerProvider.shutdown(),
          ]);
        })();
      }
      return shutdownPromise;
    },
    withActiveSpan,
    withSpan: withSpan as IsolatedOtelHandle["withSpan"],
  };
};

/** Create an isolated, non-global OTel runtime with its own Resource. */
export const createIsolatedOtel = (
  options: IsolatedOtelOptions
): IsolatedOtelHandle =>
  createIsolatedOtelRuntime(
    options,
    resourceFromAttributes(serviceResourceAttributes(options))
  );
