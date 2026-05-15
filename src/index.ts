// biome-ignore lint/performance/noBarrelFile: package public entry point
export { createLogger, type LogAttrs, type PhotonLogger } from "./logger";
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
