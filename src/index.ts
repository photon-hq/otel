// biome-ignore lint/performance/noBarrelFile: package public entry point
export { flushFetchRecords } from "./fetch-record";
export type {
  FetchCaptureReason,
  FetchRecordBody,
  FetchRecordCapture,
  FetchRecordOptions,
  FetchRecordParser,
  FetchRequestRecord,
  FetchResponseRecord,
} from "./fetch-record-options";
export {
  createInstrumentedFetch,
  type FetchInstrumentation,
  type FetchSpanOptions,
  type InstrumentFetchOptions,
  instrumentFetch,
} from "./instrument-fetch";
export {
  createIsolatedOtel,
  type IsolatedOtelHandle,
  type IsolatedOtelOptions,
} from "./isolated-runtime";
export {
  createLogger,
  getLogLevel,
  type LogAttrs,
  type LogLevel,
  type PhotonLogger,
  setLogLevel,
} from "./logger";
export {
  type SanitizeUrlOptions,
  sanitizeEmail,
  sanitizeErrorMessage,
  sanitizePhone,
  sanitizeUrl,
} from "./sanitize";
export {
  isOtelActive,
  type OtelHandle,
  type SetupOtelOptions,
  setupOtel,
} from "./setup";
export { PHOTON_OTEL_VERSION } from "./version";
export { withSpan } from "./with-span";
