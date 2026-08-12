import { version } from "../package.json";

/**
 * Current package version, reported as the instrumentation scope version on
 * tracers and loggers.
 *
 * Read from `package.json` rather than duplicated as a literal, so it cannot
 * drift from the released version: the release pipeline bumps `package.json`
 * only, and the bundler inlines this value into `dist/`. The Bun `exports`
 * condition resolves the same field straight from source.
 */
export const PHOTON_OTEL_VERSION: string = version;
