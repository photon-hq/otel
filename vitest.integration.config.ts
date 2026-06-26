import { defineConfig } from "vitest/config";

/**
 * Integration test config (`bun run test:integration`). Runs only the suite
 * under tests/integration, which drives the library against a real
 * OpenTelemetry Collector. Timeouts are raised to cover collector startup and
 * the poll-until-delivered window while reading back exported telemetry.
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
