import { describe, expect, it } from "vitest";
import { flushFetchRecords } from "../src/fetch-record";
import { resolveRecordOptions } from "../src/record-options";
import { flushServerRecords } from "../src/server-record";

describe("recording limit validation", () => {
  it.each([
    "bodyTimeoutMs",
    "parserTimeoutMs",
  ] as const)("reports the timer ceiling for record.%s", (name) => {
    expect(() =>
      resolveRecordOptions({ preset: "custom", [name]: 2_147_483_648 })
    ).toThrow(
      new TypeError(
        `record.${name} must not exceed 2147483647 milliseconds or must be Infinity`
      )
    );
    for (const value of [2_147_483_647, Number.POSITIVE_INFINITY]) {
      expect(
        resolveRecordOptions({ preset: "custom", [name]: value })?.[name]
      ).toBe(value);
    }
  });

  it.each([
    "bodyTimeoutMs",
    "parserTimeoutMs",
    "maxBodyBytes",
    "maxConcurrentCaptures",
  ] as const)("identifies invalid integers at record.%s", (name) => {
    for (const value of [
      -1,
      0.5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        resolveRecordOptions({ preset: "custom", [name]: value })
      ).toThrow(
        new TypeError(
          `record.${name} must be a nonnegative safe integer or Infinity`
        )
      );
    }
    expect(resolveRecordOptions({ preset: "custom", [name]: 0 })?.[name]).toBe(
      0
    );
  });

  it("does not apply the timer ceiling to byte or concurrency limits", () => {
    expect(
      resolveRecordOptions({
        preset: "custom",
        maxBodyBytes: Number.MAX_SAFE_INTEGER,
        maxConcurrentCaptures: Number.MAX_SAFE_INTEGER,
      })
    ).toMatchObject({
      maxBodyBytes: Number.MAX_SAFE_INTEGER,
      maxConcurrentCaptures: Number.MAX_SAFE_INTEGER,
    });
  });

  it.each([
    ["flushFetchRecords", flushFetchRecords],
    ["flushServerRecords", flushServerRecords],
  ] as const)("reports the public timeoutMs option in %s", async (_, flush) => {
    await expect(flush({ timeoutMs: -1 })).rejects.toThrow(
      new TypeError("timeoutMs must be a nonnegative safe integer or Infinity")
    );
    await expect(flush({ timeoutMs: 2_147_483_648 })).rejects.toThrow(
      new TypeError(
        "timeoutMs must not exceed 2147483647 milliseconds or must be Infinity"
      )
    );
    for (const timeoutMs of [0, 2_147_483_647, Number.POSITIVE_INFINITY]) {
      await expect(flush({ timeoutMs })).resolves.toBeUndefined();
    }
  });
});
