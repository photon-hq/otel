import { describe, expect, it } from "vitest";
import { serviceResourceAttributes } from "../src/service-resource";

describe("serviceResourceAttributes", () => {
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
});
