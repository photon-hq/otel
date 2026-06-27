/**
 * `true` when running on Bun, `false` on Node (or any other runtime).
 *
 * This is the one place the library detects its runtime. Bun's native `fetch`
 * emits no `diagnostics_channel` events, so the official OpenTelemetry
 * instrumentations (`instrumentation-undici` / `-http`) produce no spans there
 * — we must wrap `globalThis.fetch` instead. On Node we prefer the native
 * undici instrumentation. `setupOtel()` branches on this constant.
 *
 * `process.versions.bun` is the canonical signal: it survives deletion of the
 * `Bun` global and matches the codebase's `process.*` convention. Evaluated
 * once at module load — the runtime never changes mid-process.
 */
export const IS_BUN: boolean =
  typeof process !== "undefined" && process.versions?.bun !== undefined;
