import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  splitting: true,
  clean: true,
  outDir: "dist",
  target: "es2022",
  sourcemap: true,
  // Loaded lazily at runtime via createRequire on Node only; never bundle them
  // (and never pull them into the Bun-served src/ path).
  external: [
    "@opentelemetry/instrumentation",
    "@opentelemetry/instrumentation-undici",
  ],
});
