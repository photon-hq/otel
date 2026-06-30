import { describe, expect, it } from "vitest";
import {
  instrumentFetchNative,
  type RequireFn,
} from "../src/instrument-fetch-native";

interface FakeRequest {
  origin: string;
  path: string;
}

interface RecordedConfig {
  ignoreRequestHook?: (request: FakeRequest) => boolean;
}

interface FakeState {
  config?: RecordedConfig;
  disabled: number;
  registered: number;
  registeredInstrumentations?: unknown[];
}

/**
 * A fake `require` returning stub undici + instrumentation modules. It records
 * what the instrumentation was constructed/registered with so the native path
 * can be exercised on any runtime without the real packages.
 */
function makeFakeRequire(): {
  requireFn: RequireFn;
  state: FakeState;
  FakeUndiciInstrumentation: new (
    config?: RecordedConfig
  ) => { disable(): void };
} {
  const state: FakeState = { registered: 0, disabled: 0 };

  class FakeUndiciInstrumentation {
    constructor(config?: RecordedConfig) {
      state.config = config;
    }
    disable(): void {
      state.disabled += 1;
    }
  }

  const requireFn: RequireFn = (id) => {
    if (id === "@opentelemetry/instrumentation-undici") {
      return { UndiciInstrumentation: FakeUndiciInstrumentation };
    }
    if (id === "@opentelemetry/instrumentation") {
      return {
        registerInstrumentations: (config: { instrumentations: unknown[] }) => {
          state.registered += 1;
          state.registeredInstrumentations = config.instrumentations;
        },
      };
    }
    throw new Error(`unexpected require: ${id}`);
  };

  return { requireFn, state, FakeUndiciInstrumentation };
}

describe("instrumentFetchNative", () => {
  it("constructs and registers the undici instrumentation once", () => {
    const { requireFn, state, FakeUndiciInstrumentation } = makeFakeRequire();
    const handle = instrumentFetchNative(undefined, requireFn);

    expect(handle).toBeDefined();
    expect(state.registered).toBe(1);
    expect(state.registeredInstrumentations).toHaveLength(1);
    expect(state.registeredInstrumentations?.[0]).toBeInstanceOf(
      FakeUndiciInstrumentation
    );
  });

  it("disables the instrumentation on unpatch", () => {
    const { requireFn, state } = makeFakeRequire();
    const handle = instrumentFetchNative(undefined, requireFn);

    handle?.unpatch();
    expect(state.disabled).toBe(1);
  });

  it("maps ignore(url) onto ignoreRequestHook with a reconstructed absolute URL", () => {
    const { requireFn, state } = makeFakeRequire();
    const seen: string[] = [];
    instrumentFetchNative(
      {
        ignore: (url) => {
          seen.push(url);
          return url.includes("skip-me");
        },
      },
      requireFn
    );

    const hook = state.config?.ignoreRequestHook;
    expect(hook).toBeDefined();
    expect(
      hook?.({
        origin: "https://api.example.com",
        path: "/v1/skip-me?status=200",
      })
    ).toBe(true);
    expect(
      hook?.({ origin: "https://api.example.com", path: "/v1/keep?status=200" })
    ).toBe(false);
    expect(seen).toContain("https://api.example.com/v1/skip-me?status=200");
  });

  it("leaves ignoreRequestHook unset when no ignore is provided", () => {
    const { requireFn, state } = makeFakeRequire();
    instrumentFetchNative(undefined, requireFn);

    expect(state.config?.ignoreRequestHook).toBeUndefined();
  });

  it("returns undefined when the optional packages are absent", () => {
    const requireFn: RequireFn = (id) => {
      throw new Error(`Cannot find module '${id}'`);
    };

    expect(instrumentFetchNative(undefined, requireFn)).toBeUndefined();
  });

  it("declines the native path when static attributes are requested", () => {
    const { requireFn, state } = makeFakeRequire();

    // Undici can't stamp static attributes per span, so the caller must fall
    // back to the wrap — signalled by returning undefined without registering.
    expect(
      instrumentFetchNative(
        { attributes: { "peer.service": "openai" } },
        requireFn
      )
    ).toBeUndefined();
    expect(state.registered).toBe(0);
  });

  it("declines the native path when redactUrl is requested", () => {
    const { requireFn, state } = makeFakeRequire();

    // Undici has no hook to rewrite url.full, so redaction forces the wrap —
    // signalled by returning undefined without registering.
    expect(
      instrumentFetchNative({ redactUrl: (url) => url }, requireFn)
    ).toBeUndefined();
    expect(state.registered).toBe(0);
  });

  it("rethrows failures that are not a missing optional package", () => {
    const requireFn: RequireFn = () => {
      throw new Error("incompatible @opentelemetry/instrumentation-undici");
    };

    // A broken/mismatched install must surface rather than silently fall back.
    expect(() => instrumentFetchNative(undefined, requireFn)).toThrow(
      "incompatible"
    );
  });
});
