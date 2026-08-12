import {
  type Attributes,
  type Context,
  createContextKey,
  defaultTextMapGetter,
  defaultTextMapSetter,
  diag,
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { Logger, LogRecord } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
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

const INSTRUMENTATION_SCOPE = "@photon-ai/otel";
const TRACEPARENT_KEY = "traceparent";

// biome-ignore assist/source/useSortedInterfaceMembers: required options precede optional configuration.
export interface SetupOptionOtelOptions {
  /**
   * OTLP/HTTP base endpoint. `/v1/traces` and `/v1/logs` are appended by the
   * runtime. Standard main OTel environment variables do not override it.
   */
  endpoint: string;
  /** Private carrier header; the standard `traceparent` name is rejected. */
  traceparentHeader: string;
  /** Optional OTLP transport headers, typically used for Collector auth. */
  headers?: Record<string, string>;
  /** Attributes for this runtime's independent OpenTelemetry Resource. */
  resourceAttributes?: Attributes;
}

export interface OptionOtelHandle {
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

/**
 * Internal constructor exported for deterministic in-memory tests. It is not
 * re-exported from the package entry point.
 */
export const createOptionOtelRuntime = (
  options: SetupOptionOtelOptions,
  resource: Resource,
  processors?: {
    readonly logRecordProcessors?: readonly LogRecordProcessor[];
    readonly spanProcessors?: readonly SpanProcessor[];
  }
): OptionOtelHandle => {
  const endpoint = options.endpoint.trim();
  let endpointProtocol: string;
  try {
    endpointProtocol = new URL(endpoint).protocol;
  } catch {
    throw new TypeError("setupOptionOtel: endpoint must be a valid URL");
  }
  if (!(endpointProtocol === "http:" || endpointProtocol === "https:")) {
    throw new TypeError("setupOptionOtel: endpoint must use http or https");
  }
  const traceparentHeader = options.traceparentHeader;
  try {
    if (!traceparentHeader) {
      throw new TypeError("traceparentHeader is empty");
    }
    new Headers().set(traceparentHeader, "validate");
  } catch {
    throw new TypeError(
      "setupOptionOtel: traceparentHeader must be a valid HTTP header name"
    );
  }
  if (traceparentHeader.toLowerCase() === TRACEPARENT_KEY) {
    throw new TypeError(
      "setupOptionOtel: traceparentHeader must not be traceparent"
    );
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
  const localSpanKey = createContextKey("@photon-ai/option.otel.local-span");
  const traceContextPropagator = new W3CTraceContextPropagator();
  const tracer = tracerProvider.getTracer(INSTRUMENTATION_SCOPE);
  let shutdownPromise: Promise<void> | undefined;

  const propagation: OptionOtelHandle["propagation"] = {
    capture: () => contextManager.active(),
    extract: (headersObject) => {
      const value = headersObject.get(traceparentHeader);
      if (!value) {
        return;
      }
      try {
        const extracted = traceContextPropagator.extract(
          ROOT_CONTEXT,
          { [TRACEPARENT_KEY]: value },
          defaultTextMapGetter
        );
        const spanContext = trace.getSpanContext(extracted);
        if (spanContext && trace.isSpanContextValid(spanContext)) {
          return extracted;
        }
        reportDiagnostic("ignored invalid option trace header");
        return;
      } catch (error) {
        reportDiagnostic("ignored invalid option trace header", error);
        return;
      }
    },
    inject: (headersObject, captured) => {
      try {
        headersObject.delete(traceparentHeader);
        const carrier: Record<string, string> = {};
        traceContextPropagator.inject(
          captured ?? contextManager.active(),
          carrier,
          defaultTextMapSetter
        );
        const value = carrier[TRACEPARENT_KEY];
        if (value) {
          headersObject.set(traceparentHeader, value);
        }
      } catch (error) {
        reportDiagnostic("failed to inject option trace header", error);
      }
    },
    run: (captured, fn) => contextManager.with(captured, fn),
  };

  const withActiveSpan: OptionOtelHandle["withActiveSpan"] = async (
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
          span.recordException(error instanceof Error ? error : String(error));
          span.setAttribute(
            "error.type",
            error instanceof Error ? error.constructor.name : typeof error
          );
          span.setStatus({ code: SpanStatusCode.ERROR });
        } catch (telemetryError) {
          reportDiagnostic("failed to record Span error", telemetryError);
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
    withSpan: withSpan as OptionOtelHandle["withSpan"],
  };
};

/** Create an isolated, non-global OTel runtime with its own Resource. */
export const setupOptionOtel = (
  options: SetupOptionOtelOptions
): OptionOtelHandle =>
  createOptionOtelRuntime(
    options,
    resourceFromAttributes(options.resourceAttributes ?? {})
  );
