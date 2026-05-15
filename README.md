# @photon-ai/otel

A DX-focused OpenTelemetry wrapper for **Bun** and **Node.js**.

Vanilla OTel works, but the setup is verbose, the logger plumbing is awkward, and PII scrubbing is on you. `@photon-ai/otel` wraps the OTLP/HTTP stack into a few well-named functions:

- **`setupOtel()`** — idempotent one-call bootstrap for traces + logs. Honors all standard `OTEL_EXPORTER_OTLP_*` env vars.
- **`createLogger(module)`** — structured logger that writes to both the OTel logger provider and `console`, with automatic trace correlation and exception capture.
- **`withSpan(name, attrs?, fn)`** — wrap any sync or async function in a span; errors are recorded and PII in the error message is scrubbed before being attached to span status.
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
  // ... your work
});
```

If `OTEL_EXPORTER_OTLP_ENDPOINT` (or the `endpoint` option) is unset, `setupOtel()` still runs but exporters are no-ops — perfect for local development with zero config.

## API

| Function                                      | Description                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `setupOtel(options): OtelHandle`              | Boots OTLP/HTTP traces + logs. Idempotent. Returns `{ shutdown(): Promise<void> }`.                        |
| `isOtelActive(): boolean`                     | Returns `true` if `setupOtel` has already run in this process.                                             |
| `createLogger(module): PhotonLogger`          | Returns `{ info, warn, error, debug }`. Each call emits to OTel + `console`, correlates to active span.    |
| `withSpan(name, fn)`                          | Wraps `fn` (sync or async) in a span. Records exceptions and scrubs PII in error messages.                 |
| `withSpan(name, attrs, fn)`                   | Same as above but attaches `attrs` to the span.                                                            |
| `sanitizeEmail(input)`                        | Masks an email: `foo.bar@example.com` → `fo***@e***.com`.                                                  |
| `sanitizePhone(input)`                        | Masks a phone: `+13315553374` → `+133xxxxx3374`.                                                           |
| `sanitizeErrorMessage(input)`                 | Masks every email and phone embedded in a free-form string.                                                |
| `PHOTON_OTEL_VERSION`                         | Constant — current package version.                                                                        |

### Logger signatures

```ts
log.info(message, attrs?);
log.warn(message, attrs?);
log.error(message, attrs?, error?); // only error() accepts an exception
log.debug(message, attrs?);
```

`attrs` is `Record<string, string | number | boolean | undefined>`. `undefined` values are dropped.

## Configuration

Standard OpenTelemetry env vars always take precedence over `SetupOtelOptions`:

| Variable                                  | Effect                                                  |
| ----------------------------------------- | ------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`             | Base endpoint; `/v1/traces` and `/v1/logs` auto-appended. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`      | Full traces URL (overrides the base for traces).        |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`        | Full logs URL (overrides the base for logs).            |
| `OTEL_EXPORTER_OTLP_HEADERS`              | `key=value,key=value` headers; merged with `options.headers` (env wins). |
| `DEPLOYMENT_ENV`                          | Attached as `deployment.environment` resource attribute. Defaults to `development`. |

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
