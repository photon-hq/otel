// Child process for the integration test's OTEL_INSTRUMENT_FETCH=false case.
//
// setupOtel registers process-global OTel providers and is idempotent, so the
// disabled-fetch scenario can't share a process with the main (enabled) run.
// This standalone process boots its own pipeline with OTEL_INSTRUMENT_FETCH set
// to "false" (by the parent), makes one fetch, and exits — the parent then
// asserts against the collector that no CLIENT fetch span arrived for this run's
// nonce, while the control (parent) span did.
//
// It imports the BUILT bundle (dist) so it runs unchanged under both `node` and
// `bun`; the parent spawns it with process.execPath, i.e. the current runtime,
// so this leg exercises whichever runtime the suite is running on.

import { createServer } from "node:http";
import { setupOtel, withSpan } from "../../dist/index.js";

const nonce = process.env.CHILD_NONCE;
const parentSpanName = process.env.CHILD_PARENT_SPAN;
const fetchMarker = process.env.CHILD_FETCH_MARKER;

async function main() {
  const handle = setupOtel({
    serviceName: "photon-otel-integration",
    resourceAttributes: { "test.nonce": nonce },
  });

  const target = createServer((_req, res) => {
    res.statusCode = 200;
    res.end("ok");
  });
  await new Promise((resolve) => {
    target.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = target.address();

  // The control span proves this run's pipeline delivered to the collector; the
  // fetch inside it must NOT produce a CLIENT span, because fetch instrumentation
  // is disabled via OTEL_INSTRUMENT_FETCH=false.
  await withSpan(parentSpanName, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/${fetchMarker}`);
    await res.text();
  });

  await new Promise((resolve) => {
    target.close(() => resolve());
  });
  // Flush the batch processors over the wire before the process exits.
  await handle.shutdown();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
