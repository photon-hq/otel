// biome-ignore lint/performance/noBarrelFile: package public entry point
export {
  createInstrumentedFetch,
  type FetchInstrumentation,
  type FetchSpanOptions,
  type InstrumentFetchOptions,
  instrumentFetch,
} from "./instrument-fetch";
export {
  createLogger,
  getLogLevel,
  type LogAttrs,
  type LogLevel,
  type PhotonLogger,
  setLogLevel,
} from "./logger";
export {
  sanitizeEmail,
  sanitizeErrorMessage,
  sanitizePhone,
} from "./sanitize";
export {
  isOtelActive,
  type OtelHandle,
  type SetupOtelOptions,
  setupOtel,
} from "./setup";
export { PHOTON_OTEL_VERSION } from "./version";
export { withSpan } from "./with-span";
