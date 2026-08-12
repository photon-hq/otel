import type { Attributes } from "@opentelemetry/api";

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
   * `service.name` / `service.version`. An explicit entry here overrides the
   * value derived from `serviceName` / `serviceVersion`.
   */
  resourceAttributes?: Attributes;
}

/**
 * Build Resource attributes from service identity. `defaults` sit between the
 * service keys and `resourceAttributes`, so a caller can always override them.
 */
export const serviceResourceAttributes = (
  options: ServiceResourceOptions,
  defaults?: Attributes
): Attributes => ({
  "service.name": options.serviceName,
  ...(options.serviceVersion
    ? { "service.version": options.serviceVersion }
    : {}),
  ...defaults,
  ...options.resourceAttributes,
});
