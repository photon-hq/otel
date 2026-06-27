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

/**
 * Register `@opentelemetry/instrumentation-undici` — Node's native fetch
 * instrumentation, which reads the global tracer provider and propagator that
 * `setupOtel()` installs. Returns `undefined` when the optional packages aren't
 * installed, so the caller can fall back to the `globalThis.fetch` wrap.
 *
 * The packages are referenced only through `requireFn(...)` string calls (never
 * a static `import`), so esbuild can't bundle them and Bun never loads them.
 */
export function instrumentFetchNative(
  options: InstrumentFetchOptions | undefined,
  requireFn: RequireFn
): FetchInstrumentation | undefined {
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
  } catch {
    return;
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
