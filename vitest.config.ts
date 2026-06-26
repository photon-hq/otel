import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default (unit) test config used by `bun run test`. The integration suite is
 * excluded here because it requires a live OpenTelemetry Collector — it runs
 * via `bun run test:integration` (vitest.integration.config.ts) instead, so the
 * default run stays fast and offline.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/integration/**"],
  },
});
