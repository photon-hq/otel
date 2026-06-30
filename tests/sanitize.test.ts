import { describe, expect, it } from "vitest";
import {
  sanitizeEmail,
  sanitizeErrorMessage,
  sanitizePhone,
  sanitizeUrl,
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

describe("sanitizeUrl", () => {
  it("redacts a listed query param, keeping others and the path", () => {
    expect(
      sanitizeUrl("https://h.example.com/p?token=abc&keep=1", {
        params: ["token"],
      })
    ).toBe("https://h.example.com/p?token=REDACTED&keep=1");
  });

  it("redacts the semconv default params with no options", () => {
    expect(
      sanitizeUrl("https://h.example.com/p?sig=abc&X-Amz-Signature=def&keep=1")
    ).toBe(
      "https://h.example.com/p?sig=REDACTED&X-Amz-Signature=REDACTED&keep=1"
    );
  });

  it("redacts user:pass credentials", () => {
    expect(sanitizeUrl("https://user:pass@h.example.com/p")).toBe(
      "https://REDACTED:REDACTED@h.example.com/p"
    );
  });

  it("returns the input unchanged when nothing matches", () => {
    const url = "https://h.example.com/p?keep=1";
    expect(sanitizeUrl(url)).toBe(url);
  });

  it("returns unparseable input unchanged", () => {
    expect(sanitizeUrl("not a url")).toBe("not a url");
  });

  it("redacts only the listed params when redactDefaults is false", () => {
    expect(
      sanitizeUrl("https://user:pass@h.example.com/p?token=abc&sig=def", {
        params: ["token"],
        redactDefaults: false,
      })
    ).toBe("https://user:pass@h.example.com/p?token=REDACTED&sig=def");
  });
});
