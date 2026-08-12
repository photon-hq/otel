import { describe, expect, it } from "vitest";
import { version } from "../package.json";
import { PHOTON_OTEL_VERSION } from "../src/version";

describe("PHOTON_OTEL_VERSION", () => {
  // Guards against reintroducing a hand-maintained literal, which silently
  // drifted from package.json for several releases. CI additionally asserts the
  // inlined value in dist/ (see .github/workflows/ci.yml).
  it("tracks the package version without a duplicated literal", () => {
    expect(PHOTON_OTEL_VERSION).toBe(version);
  });
});
