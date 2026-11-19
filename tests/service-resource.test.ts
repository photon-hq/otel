import { afterEach, describe, expect, it } from "vitest";
import { serviceResourceAttributes } from "../src/service-resource";

describe("serviceResourceAttributes", () => {
  afterEach(() => {
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    delete process.env.OTEL_SERVICE_NAME;
  });

  it("names the process with one service.instance.id", () => {
    const first = serviceResourceAttributes({ serviceName: "orders-api" });
    const second = serviceResourceAttributes({ serviceName: "billing-api" });
    expect(first["service.instance.id"]).toEqual(expect.any(String));
    expect(first["service.instance.id"]).not.toBe("");
    expect(second["service.instance.id"]).toBe(first["service.instance.id"]);
  });

  it("lets resourceAttributes override service.instance.id", () => {
    const attributes = serviceResourceAttributes({
      serviceName: "orders-api",
      resourceAttributes: { "service.instance.id": "orders-api-0" },
    });
    expect(attributes["service.instance.id"]).toBe("orders-api-0");
  });

  it("merges OTEL_RESOURCE_ATTRIBUTES via envDetector with proper precedence", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.instance.id=pod-uid-123,k8s.pod.name=platforms-abc,deployment.environment=production";
    process.env.OTEL_SERVICE_NAME = "ignored-env-service";

    const attributes = serviceResourceAttributes(
      {
        serviceName: "service.platforms",
        serviceVersion: "1.2.3",
        resourceAttributes: { "custom.key": "from-options" },
      },
      { "deployment.environment": "development" }
    );

    expect(attributes).toMatchObject({
      "service.name": "service.platforms",
      "service.version": "1.2.3",
      "service.instance.id": "pod-uid-123",
      "k8s.pod.name": "platforms-abc",
      "deployment.environment": "production",
      "custom.key": "from-options",
    });
  });

  it("lets explicit resourceAttributes override OTEL_RESOURCE_ATTRIBUTES", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.instance.id=pod-uid-123";

    const attributes = serviceResourceAttributes({
      serviceName: "orders-api",
      resourceAttributes: { "service.instance.id": "explicit-id" },
    });

    expect(attributes["service.instance.id"]).toBe("explicit-id");
  });
});
