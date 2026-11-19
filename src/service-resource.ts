import { randomUUID } from "node:crypto";
import type { Attributes } from "@opentelemetry/api";
import { envDetector } from "@opentelemetry/resources";

// One id per process: replicas of a service then export separate series
// instead of overwriting each other's cumulative metrics.
const serviceInstanceId = randomUUID();

const detectEnvResourceAttributes = (): Attributes => {
  const detected = envDetector.detect().attributes;
  if (!detected) {
    return {};
  }
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(detected)) {
    if (value !== undefined && !(value instanceof Promise)) {
      attributes[key] = value;
    }
  }
  return attributes;
};

/**
 * Service identity shared by every runtime this package builds. `setupOtel()`
 * and `createIsolatedOtel()` both accept these, so a service is named the same
 * way regardless of which runtime exports its telemetry.
 */
// biome-ignore assist/source/useSortedInterfaceMembers: required identity precedes optional configuration.
export interface ServiceResourceOptions {
  /** Value of the `service.name` Resource attribute. */
  serviceName: string;
  /** Value of the `service.version` Resource attribute; omitted when unset. */
  serviceVersion?: string;
  /**
   * Extra resource attributes attached to every span/log/metric alongside
   * `service.name` / `service.version` / `service.instance.id`. An explicit
   * entry here overrides the value this package derives.
   */
  resourceAttributes?: Attributes;
}

/**
 * Build Resource attributes from service identity, standard
 * `OTEL_RESOURCE_ATTRIBUTES` env detection, and a `service.instance.id`
 * generated once per process as fallback.
 *
 * Precedence (lowest to highest):
 * 1. Process-generated `service.instance.id`
 * 2. `defaults` (e.g. `deployment.environment`)
 * 3. `OTEL_RESOURCE_ATTRIBUTES` (via `@opentelemetry/resources` `envDetector`)
 * 4. `options.serviceName` / `options.serviceVersion`
 * 5. `options.resourceAttributes`
 */
export const serviceResourceAttributes = (
  options: ServiceResourceOptions,
  defaults?: Attributes
): Attributes => ({
  "service.instance.id": serviceInstanceId,
  ...defaults,
  ...detectEnvResourceAttributes(),
  "service.name": options.serviceName,
  ...(options.serviceVersion
    ? { "service.version": options.serviceVersion }
    : {}),
  ...options.resourceAttributes,
});
