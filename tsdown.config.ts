import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  outDir: "dist",
  target: "es2022",
  sourcemap: true,
  // Keep the published file names (dist/index.js, dist/index.d.ts) that the
  // package "exports" map and consumers rely on; tsdown defaults to .mjs/.d.mts.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  deps: {
    // Loaded lazily at runtime via createRequire on Node only; never bundle them
    // (and never pull them into the Bun-served src/ path).
    neverBundle: [
      "@opentelemetry/instrumentation",
      "@opentelemetry/instrumentation-undici",
    ],
  },
});
