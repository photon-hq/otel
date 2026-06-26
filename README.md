# @photon-ai/otel

A DX-focused OpenTelemetry wrapper for **Bun** and **Node.js**.

Vanilla OTel works, but the setup is verbose, the logger plumbing is awkward, and PII scrubbing is on you. `@photon-ai/otel` wraps the OTLP/HTTP stack into a few well-named functions:

- **`setupOtel()`** — idempotent one-call bootstrap for traces + logs. Honors all standard `OTEL_EXPORTER_OTLP_*` env vars.
- **`createLogger(module)`** — structured logger that writes to both the OTel logger provider and `console`, with automatic trace correlation and exception capture. Every level (`debug`/`info`/`warn`/`error`) accepts `attrs` **and** an `error`, and is gated by a configurable `LOG_LEVEL`.
- **`withSpan(name, attrs?, fn)`** — wrap any sync or async function in a span; errors are recorded and PII in the error message is scrubbed before being attached to span status.
- **Automatic `fetch` tracing** — `setupOtel()` wraps `globalThis.fetch` so every outbound request gets a CLIENT span and W3C trace-context headers. On **Bun** this is the only fetch instrumentation that works — the standard `diagnostics_channel`-based OTel instrumentations emit nothing for Bun's native fetch — and it behaves identically on Node.
- **`sanitizeEmail` / `sanitizePhone` / `sanitizeErrorMessage`** — PII helpers you can reuse anywhere.

OTLP/HTTP only (no gRPC, no proto). Works identically on Bun and Node ≥ 20.

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
| `setupOtel(options): OtelHandle`              | Boots OTLP/HTTP traces + logs. Idempotent. Returns `{ shutdown(): Promise<void> }`.                        |
| `isOtelActive(): boolean`                     | Returns `true` if `setupOtel` has already run in this process.                                             |
| `instrumentFetch(options?): FetchInstrumentation` | Wraps `globalThis.fetch` for CLIENT spans + W3C propagation. Auto-enabled by `setupOtel` when traces are configured. Returns `{ unpatch() }`. |
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

`setupOtel()` patches `globalThis.fetch` to emit a CLIENT span per outbound request, carrying
W3C `traceparent` (and baggage) headers so traces continue across services. Each span is named by
HTTP method (`GET`, `POST`, …) and carries `http.request.method`, `url.full`, `server.address`,
`server.port`, and `http.response.status_code`; `4xx`/`5xx` responses and thrown network errors are
marked `ERROR`. This covers **outbound** requests only — inbound `Bun.serve`/Elysia server spans are
separate (see [Framework integration](#framework-integration)).

- **Default:** on when a traces endpoint is configured. Pass `instrumentFetch: false` to disable, or
  `instrumentFetch: true` to force it on even without an endpoint.
- **Filter URLs:** `instrumentFetch: { ignore: (url) => url.includes("/healthz") }`. Your own OTLP
  endpoint is always excluded automatically, so the exporter never traces itself.
- **Why Bun needs this:** Bun's native `fetch` emits no `diagnostics_channel` events, so
  `@opentelemetry/instrumentation-undici` / `-http` — and `opentelemetry-instrumentation-fetch-node`,
  which is itself `diagnostics_channel`-based — produce no spans. Wrapping the global is the only
  mechanism that works, and it behaves identically on Node.
- **Caveat:** `url.full` includes the query string. If your URLs carry secrets there, use `ignore`
  or redact upstream.

`setupOtel()` also installs a global W3C trace-context + baggage propagator (previously none was
registered) — that is what makes the outbound `traceparent` injection, and any manual propagation,
actually take effect.

## Running on Node vs Bun

The same code runs unmodified on both. Pick whichever you prefer:

```bash
bun run src/server.ts
# or
node --experimental-strip-types src/server.ts
```

The package uses `process.env` (not `Bun.env`) and `AsyncLocalStorageContextManager` (backed by `async_hooks`), both of which are supported natively by Bun and Node ≥ 20.

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
