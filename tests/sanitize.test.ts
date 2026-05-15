import { describe, expect, it } from "vitest";
import {
  sanitizeEmail,
  sanitizeErrorMessage,
  sanitizePhone,
} from "../src/sanitize";

describe("sanitizeEmail", () => {
  it("masks standard email", () => {
    expect(sanitizeEmail("foo.bar@example.com")).toBe("fo***@e***.com");
  });

  it("preserves the TLD", () => {
    expect(sanitizeEmail("alice@subdomain.co.uk")).toBe("al***@s***.uk");
  });

  it("returns *** for inputs missing a local part", () => {
    expect(sanitizeEmail("@example.com")).toBe("***");
  });

  it("returns *** for inputs missing a domain dot", () => {
    expect(sanitizeEmail("foo@nodot")).toBe("***");
  });
});

describe("sanitizePhone", () => {
  it("masks an E.164 phone preserving the plus", () => {
    expect(sanitizePhone("+13315553374")).toBe("+133xxxx3374");
  });

  it("masks a domestic phone without plus", () => {
    expect(sanitizePhone("3315553374")).toBe("331xxx3374");
  });

  it("returns xxxx for too-short inputs", () => {
    expect(sanitizePhone("12345")).toBe("xxxx");
  });

  it("returns +xxxx for too-short inputs with a plus", () => {
    expect(sanitizePhone("+12345")).toBe("+xxxx");
  });
});

describe("sanitizeErrorMessage", () => {
  it("masks emails embedded in free-form text", () => {
    expect(sanitizeErrorMessage("user foo.bar@example.com not found")).toBe(
      "user fo***@e***.com not found"
    );
  });

  it("masks phones embedded in free-form text", () => {
    const result = sanitizeErrorMessage("called +13315553374 but no answer");
    expect(result).toContain("+133");
    expect(result).toContain("3374");
    expect(result).not.toContain("5555");
  });

  it("masks both emails and phones in a single message", () => {
    const out = sanitizeErrorMessage(
      "contact foo.bar@example.com or +13315553374"
    );
    expect(out).toContain("fo***@e***.com");
    expect(out).toContain("3374");
    expect(out).not.toContain("foo.bar@example.com");
    expect(out).not.toContain("5555");
  });

  it("leaves messages without PII untouched", () => {
    expect(sanitizeErrorMessage("simple failure")).toBe("simple failure");
  });
});
