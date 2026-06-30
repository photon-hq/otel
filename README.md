# @photon-ai/otel

A DX-focused OpenTelemetry wrapper for **Bun** and **Node.js**.

Vanilla OTel works, but the setup is verbose, the logger plumbing is awkward, and PII scrubbing is on you. `@photon-ai/otel` wraps the OTLP/HTTP stack into a few well-named functions:

- **`setupOtel()`** — idempotent one-call bootstrap for traces + logs. Honors all standard `OTEL_EXPORTER_OTLP_*` env vars.
- **`createLogger(module)`** — structured logger that writes to both the OTel logger provider and `console`, with automatic trace correlation and exception capture. Every level (`debug`/`info`/`warn`/`error`) accepts `attrs` **and** an `error`, and is gated by a configurable `LOG_LEVEL`.
- **`withSpan(name, attrs?, fn)`** — wrap any sync or async function in a span; errors are recorded and PII in the error message is scrubbed before being attached to span status.
- **Automatic `fetch` tracing** — `setupOtel()` instruments outbound `fetch` so every request gets a CLIENT span and W3C trace-context headers. On **Node** it uses the official `@opentelemetry/instrumentation-undici`; on **Bun** — whose native fetch emits nothing for the standard `diagnostics_channel`-based instrumentations — it wraps `globalThis.fetch`. Pass `instrumentFetch: { mode: "global" }` to force the wrap on both for identical spans.
- **`sanitizeEmail` / `sanitizePhone` / `sanitizeErrorMessage`** — PII helpers you can reuse anywhere.

OTLP/HTTP only (no gRPC, no proto). Runs on Bun and Node ≥ 20.

## Install

```bash
bun add @photon-ai/otel
# or
npm install @photon-ai/otel
```

## Quick start

```ts
import { createLogger, setupOtel, withSpan } from "@photon-ai/otel";

setupOtel({
  serviceName: "my-service",
  serviceVersion: "1.0.0",
  endpoint: "https://otel.example.com", // optional; env var wins
});

const log = createLogger("server");

await withSpan("handle-request", { route: "/users" }, async () => {
  log.info("processing request", { userId: 42 });
  // Outbound fetch is traced automatically: a CLIENT span, parented to this
  // one, with a `traceparent` header injected for the downstream service.
  await fetch("https://api.example.com/users");
});
```

If `OTEL_EXPORTER_OTLP_ENDPOINT` (or the `endpoint` option) is unset, `setupOtel()` still runs but exporters are no-ops — perfect for local development with zero config.

## API

| Function                                      | Description                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `setupOtel(options): OtelHandle`              | Boots OTLP/HTTP traces + logs. Idempotent. Returns `{ shutdown(), tracerProvider, loggerProvider }`. Pass `register: false` for scoped mode (no global takeover). |
| `isOtelActive(): boolean`                     | Returns `true` if `setupOtel` has already run in this process.                                             |
| `instrumentFetch(options?): FetchInstrumentation` | Low-level wrap of `globalThis.fetch` for CLIENT spans + W3C propagation. Returns `{ unpatch() }`. `setupOtel` calls this on Bun; on Node it prefers native undici. |
| `createInstrumentedFetch(baseFetch?, options?): typeof fetch` | Returns a NEW instrumented fetch (CLIENT spans + W3C propagation) wrapping `baseFetch` (default `globalThis.fetch`) without touching the global. For SDKs that take a `fetch` option. |
| `createLogger(module): PhotonLogger`          | Returns `{ info, warn, error, debug }`. Each call emits to OTel + `console`, correlates to active span.    |
| `setLogLevel(level): void`                    | Set the minimum level emitted (`debug`/`info`/`warn`/`error`/`silent`). `LOG_LEVEL` env still wins.        |
| `getLogLevel(): LogLevel`                     | Current effective level after env / override / default resolution.                                        |
| `withSpan(name, fn)`                          | Wraps `fn` (sync or async) in a span. Records exceptions and scrubs PII in error messages.                 |
| `withSpan(name, attrs, fn)`                   | Same as above but attaches `attrs` to the span.                                                            |
| `sanitizeEmail(input)`                        | Masks an email: `foo.bar@example.com` → `fo***@e***.com`.                                                  |
| `sanitizePhone(input)`                        | Masks a phone: `+13315553374` → `+133xxxxx3374`.                                                           |
| `sanitizeErrorMessage(input)`                 | Masks every email and phone embedded in a free-form string.                                                |
| `PHOTON_OTEL_VERSION`                         | Constant — current package version.                                                                        |

### Logger signatures

```ts
log.debug(message, attrs?, error?);
log.info(message, attrs?, error?);
log.warn(message, attrs?, error?); // attach the exception that caused a retry
log.error(message, attrs?, error?);
```

Every level takes the same `(message, attrs?, error?)` shape — attach an exception to a
`warn`/`info`/`debug`, not just `error`. `attrs` is
`Record<string, string | number | boolean | undefined>`; `undefined` values are dropped.

An `Error` is recorded as `exception.type` / `exception.message` / `exception.stacktrace`
on the OTLP record (per the OTel exception semantic convention); a non-`Error` throw is
coerced so at least `exception.message` is preserved.

Each call also prints a single human-readable console line — `[module] LEVEL message
{ ...attrs }` plus the raw error (so the runtime renders the full stack) — routed to
`console.debug` / `console.info` / `console.warn` / `console.error` by severity. Both
sinks share one level gate.

### Log level

Logs below the active level are dropped from **both** OTLP and the console. The level is
resolved fresh on every call, so changes take effect immediately:

1. `LOG_LEVEL` env var (`debug` | `info` | `warn` | `error` | `silent`) — wins if set.
2. `setLogLevel(level)` or `setupOtel({ logLevel })`.
3. Default: `debug` in development (`DEPLOYMENT_ENV` unset or `development`), `info` otherwise.

```ts
import { setLogLevel } from "@photon-ai/otel";

setLogLevel("warn"); // debug + info now suppressed everywhere
// or set LOG_LEVEL=warn in the environment, which overrides the call above
```

`"silent"` suppresses everything, including errors.

## Configuration

Standard OpenTelemetry env vars always take precedence over `SetupOtelOptions`:

| Variable                                  | Effect                                                  |
| ----------------------------------------- | ------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`             | Base endpoint; `/v1/traces` and `/v1/logs` auto-appended. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`      | Full traces URL (overrides the base for traces).        |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`        | Full logs URL (overrides the base for logs).            |
| `OTEL_EXPORTER_OTLP_HEADERS`              | `key=value,key=value` headers; merged with `options.headers` (env wins). |
| `DEPLOYMENT_ENV`                          | Attached as `deployment.environment` resource attribute. Defaults to `development`. Also drives the default log level. |
| `LOG_LEVEL`                               | Minimum log level: `debug` \| `info` \| `warn` \| `error` \| `silent`. Overrides `setLogLevel()` / `setupOtel({ logLevel })`. |

## Automatic fetch instrumentation

`setupOtel()` instruments outbound `fetch` to emit a CLIENT span per request, carrying W3C
`traceparent` (and baggage) headers so traces continue across services. Spans are named by HTTP
method (`GET`, `POST`, …) and carry `http.request.method`, `url.full`, `server.address`,
`server.port`, and `http.response.status_code`. This covers **outbound** requests only — inbound
`Bun.serve`/Elysia server spans are separate (see [Framework integration](#framework-integration)).

The strategy depends on the runtime (`mode: "auto"`, the default):

- **Node** uses the official `@opentelemetry/instrumentation-undici` (Node's `fetch` is undici-backed).
  It captures all undici traffic — not just `globalThis.fetch` — emits the full HTTP-client semantic
  conventions (`url.scheme`, `url.path`, `network.peer.*`, `user_agent.original`, …), and never
  monkey-patches the global. It ships as an optional dependency; if it isn't installed, the library
  falls back to the global wrap.
- **Bun** wraps `globalThis.fetch` directly. Bun's native `fetch` emits no `diagnostics_channel`
  events, so `@opentelemetry/instrumentation-undici` / `-http` produce no spans there — wrapping the
  global is the only mechanism that works.

Options (`instrumentFetch`):

- **`true` / `false`:** force on (even without an endpoint) / off. Defaults to on when a traces
  endpoint is configured.
- **`mode`:** `"auto"` (default — native on Node, wrap on Bun) or `"global"` (wrap on both runtimes).
  Choose `"global"` when you want identical spans everywhere and the built-in PII scrubbing of error
  messages kept on Node (see caveats).
- **`ignore`:** `instrumentFetch: { ignore: (url) => url.includes("/healthz") }`. Your own OTLP
  endpoint is always excluded automatically, so the exporter never traces itself.

Caveats:

- **Telemetry differs by runtime under `"auto"`.** undici (Node) emits richer attributes and follows
  HTTP semconv for span status — a 2xx client span is left `UNSET`, and only `5xx`/network failures are
  marked `ERROR`; the Bun wrap marks all `4xx`/`5xx` as `ERROR`. The Bun wrap also scrubs PII from the
  error message attached to span status — **undici does not**. Use `mode: "global"` for parity.
- **`url.full` includes the query string** on both. If your URLs carry secrets there, use `ignore` or
  redact upstream.
- **Native fetch tracing needs Node ≥ 20.6** (the undici instrumentation's floor); older 20.x falls
  back to the global wrap.

`setupOtel()` also installs a global W3C trace-context + baggage propagator (previously none was
registered) — that is what makes the outbound `traceparent` injection, and any manual propagation,
actually take effect.

## Instrumenting a specific fetch (SDKs)

Sometimes you don't want to touch `globalThis.fetch` — you just want one SDK's outbound calls traced.
`createInstrumentedFetch(baseFetch?, options?)` returns a **new** fetch (CLIENT spans + W3C
`traceparent` injection) wrapping `baseFetch` (default `globalThis.fetch`, read at call time) **without
mutating the global**. Pass it wherever an SDK accepts a `fetch`:

```ts
import { createInstrumentedFetch } from "@photon-ai/otel";
import OpenAI from "openai";

const client = new OpenAI({
  // tag every span from this SDK so it's distinguishable from other traffic
  fetch: createInstrumentedFetch(undefined, {
    attributes: { "peer.service": "openai" },
  }),
});
```

- Returns a fetch function directly — there's no global lifecycle, so no `unpatch()` handle.
- Idempotent: passing an already-instrumented fetch returns it unchanged.
- `options`: `ignore: (url) => boolean` skips spans for some URLs; `attributes` merges static attributes
  into every span (the practical way to tell different SDKs' spans apart).
- Always uses the wrapper technique, so it behaves identically on Bun and Node (the native undici
  instrumentation can't target a single instance).

**Avoid double-counting on Node.** If `setupOtel()`'s global fetch instrumentation is active (the
default on Node uses undici, which captures *all* undici traffic), an SDK request made through a
per-instance wrapper is recorded **twice** — once by the wrapper, once by undici. When instrumenting
SDKs per-instance, disable the global path with `setupOtel({ instrumentFetch: false })` (or reserve
per-instance wrapping for SDKs you accept doubling on). **Bun has no such issue** — its global wrap only
affects `globalThis.fetch`, so a separately-passed instrumented fetch is counted once.

## Scoped mode (embedding in a library)

By default `setupOtel()` registers the process-global OpenTelemetry tracer/logger providers — the
convenient app-level setup. If you're building a **library** that ships its own telemetry, that would
take over the host application's OpenTelemetry. Pass `register: false` to run **scoped**:

```ts
const otel = setupOtel({ serviceName: "my-lib", register: false });

// withSpan / createLogger emit into the library's own providers...
await withSpan("work", async () => {
  /* ... */
});
// ...and the host app's global tracer/logger providers are left untouched.
```

In scoped mode:

- **No global takeover.** `setupOtel()` does not call `setGlobalTracerProvider` / `setGlobalLoggerProvider`;
  the library's spans and logs flow to its own providers while the host keeps its global OTel.
- **The top-level helpers still work** — `withSpan`, `createLogger`, and `createInstrumentedFetch` resolve
  through the library's providers automatically.
- **Shared context is preserved.** A W3C propagator and an `AsyncLocalStorageContextManager` are installed
  only if absent, so span nesting and `traceparent` propagation work — and if the host already set them, the
  library shares the host's (spans nest across the boundary).
- **Auto fetch instrumentation defaults off** (wrapping `globalThis.fetch` is process-wide, and native undici
  can only read the global provider). Trace a specific client with `createInstrumentedFetch()` instead.
- **The handle exposes the providers** — `otel.tracerProvider` / `otel.loggerProvider` — if you need to build
  extra tracers or wire additional processors.

## Running on Node vs Bun

The same code runs unmodified on both. Pick whichever you prefer:

```bash
bun run src/server.ts
# or
node --experimental-strip-types src/server.ts
```

The package uses `process.env` (not `Bun.env`) and `AsyncLocalStorageContextManager` (backed by `async_hooks`), both of which are supported natively by Bun and Node ≥ 20.

The one runtime-specific behavior is fetch instrumentation — native undici on Node, a `globalThis.fetch` wrap on Bun (see [Automatic fetch instrumentation](#automatic-fetch-instrumentation)). Set `instrumentFetch: { mode: "global" }` for identical behavior on both.

For Bun consumers, the `exports` map points at the TypeScript source via the `bun` condition for faster cold starts during dev. Node consumers get the pre-built ESM bundle.

## Why HTTP exporters only?

- Bun's gRPC support is incomplete in some paths — HTTP is reliable everywhere.
- JSON-over-HTTP is trivial to debug with `curl` and a packet sniffer.
- One fewer transport keeps the dependency surface small.

If you need gRPC, instantiate your own exporter and processor with `@opentelemetry/api` directly — `setupOtel()` is opinionated, not a wall.

## Framework integration

This package is framework-agnostic. For Elysia.js (Bun-native), see the [`elysiajs-otel` skill](https://github.com/anthropics/claude-code) for a recipe combining `@photon-ai/otel` with `@elysiajs/opentelemetry` auto-instrumentation. A dedicated `@photon-ai/otel-elysia` package may follow.

## License

MIT
