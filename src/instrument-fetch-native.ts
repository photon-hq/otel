import type {
  FetchInstrumentation,
  InstrumentFetchOptions,
} from "./instrument-fetch";

/**
 * A `require`-like loader. Injected (rather than calling `createRequire` in this
 * module) so the native path is unit-testable on any runtime — including Bun,
 * where the real packages would never be loaded — with a fake implementation.
 */
export type RequireFn = (id: string) => unknown;

/** Minimal shape of the request object passed to undici's `ignoreRequestHook`. */
interface UndiciRequestLike {
  origin: string;
  path: string;
}

interface UndiciInstrumentationConfig {
  ignoreRequestHook?: (request: UndiciRequestLike) => boolean;
}

interface UndiciInstrumentationInstance {
  disable(): void;
}

type UndiciInstrumentationCtor = new (
  config?: UndiciInstrumentationConfig
) => UndiciInstrumentationInstance;

type RegisterInstrumentationsFn = (config: {
  instrumentations: unknown[];
}) => unknown;

/**
 * Reconstruct the absolute URL undici describes from `origin` + `path`, matching
 * how the instrumentation builds `url.full`. This lets the caller's `ignore(url)`
 * predicate (and the OTLP self-trace exclusion) behave identically to the
 * global-wrap path.
 */
function toAbsoluteUrl(request: UndiciRequestLike): string {
  try {
    return new URL(request.path, request.origin).toString();
  } catch {
    return `${request.origin}${request.path}`;
  }
}

/** Node's "module isn't installed" errors carry one of these messages. */
const MODULE_NOT_FOUND_MESSAGE = /Cannot find (module|package)/;

/**
 * True only when `error` signals an optional package being absent, so the caller
 * can safely fall back to the `globalThis.fetch` wrap. A version mismatch or a
 * throw from the package's own initialization is a real failure and must be
 * rethrown rather than masked as "not installed".
 */
function isModuleNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
    return true;
  }
  return typeof message === "string" && MODULE_NOT_FOUND_MESSAGE.test(message);
}

/**
 * Register `@opentelemetry/instrumentation-undici` — Node's native fetch
 * instrumentation, which reads the global tracer provider and propagator that
 * `setupOtel()` installs. Returns `undefined` when the optional packages aren't
 * installed, or when static `attributes` are requested (the undici path has no
 * hook to stamp them on every span), so the caller can fall back to the
 * `globalThis.fetch` wrap.
 *
 * The packages are referenced only through `requireFn(...)` string calls (never
 * a static `import`), so esbuild can't bundle them and Bun never loads them.
 */
export function instrumentFetchNative(
  options: InstrumentFetchOptions | undefined,
  requireFn: RequireFn
): FetchInstrumentation | undefined {
  // The undici instrumentation exposes no hook to stamp caller-supplied static
  // attributes on every span, nor to rewrite `url.full` for redaction. When
  // either is requested, decline the native path and let the caller fall back
  // to the globalThis.fetch wrap (which applies both).
  const hasStaticAttributes =
    options?.attributes !== undefined &&
    Object.keys(options.attributes).length > 0;
  if (hasStaticAttributes || options?.redactUrl !== undefined) {
    return;
  }

  let UndiciInstrumentation: UndiciInstrumentationCtor;
  let registerInstrumentations: RegisterInstrumentationsFn;
  try {
    const undiciModule = requireFn("@opentelemetry/instrumentation-undici") as {
      UndiciInstrumentation: UndiciInstrumentationCtor;
    };
    const instrumentationModule = requireFn(
      "@opentelemetry/instrumentation"
    ) as {
      registerInstrumentations: RegisterInstrumentationsFn;
    };
    UndiciInstrumentation = undiciModule.UndiciInstrumentation;
    registerInstrumentations = instrumentationModule.registerInstrumentations;
  } catch (error) {
    // Only "package not installed" is a valid fall-back-to-wrap signal; a
    // version mismatch or a broken install must surface, not be swallowed.
    if (isModuleNotFoundError(error)) {
      return;
    }
    throw error;
  }

  const userIgnore = options?.ignore;
  const instrumentation = new UndiciInstrumentation({
    ignoreRequestHook: userIgnore
      ? (request) => userIgnore(toAbsoluteUrl(request))
      : undefined,
  });
  registerInstrumentations({ instrumentations: [instrumentation] });

  return {
    unpatch() {
      instrumentation.disable();
    },
  };
}
