# Integration test: real OTel Collector round-trip

`otel-collector.test.ts` is a true end-to-end test. Unlike the unit tests (which
use in-memory exporters), it drives the public API — `setupOtel` →
`withSpan` / `createLogger` / `getMeter` → `shutdown` — against a **real OpenTelemetry
Collector** over OTLP/HTTP, then reads the collector's `file`-exporter output
back and asserts on the spans, logs, and metrics it actually received: names,
attributes, status, severity, PII scrubbing, and trace/log correlation.

`fetch-record.test.ts` also checks raw and custom structured fetch records,
unchanged outgoing request bodies, repeated response cookies, trace/span IDs,
and background response capture drained by `shutdown()` before the caller reads
the response. It verifies that explicit recording works with `logLevel: "silent"`.

It is intentionally excluded from `bun run test` (which stays offline). It runs
via `bun run test:integration` and needs the collector running.

## Run it locally

```sh
# 1. Start the collector (OTLP/HTTP on :4318, health check on :13133)
cd tests/integration
mkdir -p output
docker compose up -d

# 2. Wait until it's healthy
curl -sf http://localhost:13133/ >/dev/null && echo healthy

# 3. Run the test from the repo root
cd ../..
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 bun --bun run test:integration

# (optional) eyeball the raw telemetry the collector received
cat tests/integration/output/traces.json
cat tests/integration/output/logs.json
cat tests/integration/output/metrics.json

# 4. Tear down
cd tests/integration && docker compose down -v
```

The test defaults `OTEL_EXPORTER_OTLP_ENDPOINT` to `http://localhost:4318` if
unset, so step 3 works without the env var too. Output files land in
`tests/integration/output/` (git-ignored); override the read location with
`COLLECTOR_OUTPUT_DIR`.

## How it works

- `docker-compose.yml` runs `otel/opentelemetry-collector-contrib` (pinned)
  with `collector-config.yaml`.
- The collector receives OTLP/HTTP and writes each signal to its own file via
  the `file` exporter (`output/traces.json`, `output/logs.json`,
  `output/metrics.json`), plus mirrors everything to stdout via the `debug`
  exporter (`docker compose logs`).
- The test tags every signal with a unique per-run nonce, calls
  `handle.shutdown()` to flush the providers over the wire, then polls
  the output files until its telemetry arrives before asserting.

This is the same flow CI runs in `.github/workflows/integration.yml`.
