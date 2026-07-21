import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createLogger, getLogLevel, setLogLevel } from "../src/logger";

const exporter = new InMemoryLogRecordExporter();

function clearEnv(): void {
  delete process.env.LOG_LEVEL;
  delete process.env.DEPLOYMENT_ENV;
}

function spyOnConsole(): void {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

beforeAll(() => {
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor(exporter)],
  });
  logs.setGlobalLoggerProvider(provider);
});

function lastRecord() {
  const records = exporter.getFinishedLogRecords();
  return records.at(-1);
}

describe("createLogger", () => {
  beforeEach(() => {
    clearEnv();
    setLogLevel("debug");
    exporter.reset();
    spyOnConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches attrs to the OTLP record on every level", () => {
    const log = createLogger("svc");
    log.debug("d", { a: 1 });
    log.info("i", { b: 2 });
    log.warn("w", { c: 3 });
    log.error("e", { d: 4 });

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(4);
    expect(records[0]?.attributes).toMatchObject({ "log.module": "svc", a: 1 });
    expect(records[1]?.attributes).toMatchObject({ b: 2 });
    expect(records[2]?.attributes).toMatchObject({ c: 3 });
    expect(records[3]?.attributes).toMatchObject({ d: 4 });
  });

  it("drops undefined attr values", () => {
    const log = createLogger("svc");
    log.info("msg", { kept: "yes", skipped: undefined });

    expect(lastRecord()?.attributes).toMatchObject({ kept: "yes" });
    expect(lastRecord()?.attributes).not.toHaveProperty("skipped");
  });

  it("captures an Error as exception.* attributes on info/warn/debug", () => {
    const log = createLogger("svc");
    const err = new Error("kaboom");
    log.warn("transient failure", { attempt: 2 }, err);

    const attrs = lastRecord()?.attributes ?? {};
    expect(attrs["exception.type"]).toBe("Error");
    expect(attrs["exception.message"]).toBe("kaboom");
    expect(attrs["exception.stacktrace"]).toContain("kaboom");
    expect(attrs.attempt).toBe(2);
  });

  it("coerces a non-Error throw into exception.message", () => {
    const log = createLogger("svc");
    log.debug("weird throw", undefined, "just a string");

    const attrs = lastRecord()?.attributes ?? {};
    expect(attrs["exception.type"]).toBe("string");
    expect(attrs["exception.message"]).toBe("just a string");
  });

  it("sets the correct severity number and text", () => {
    const log = createLogger("svc");
    log.warn("w");

    expect(lastRecord()?.severityNumber).toBe(SeverityNumber.WARN);
    expect(lastRecord()?.severityText).toBe("WARN");
  });

  it("prints module, level, message, attrs, and error to the console", () => {
    const log = createLogger("svc");
    const err = new Error("boom");
    log.info("processing", { userId: 42 });
    log.error("failed", { route: "/x" }, err);

    expect(console.info).toHaveBeenCalledWith("[svc]", "INFO", "processing", {
      userId: 42,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[svc]",
      "ERROR",
      "failed",
      { route: "/x" },
      err
    );
  });

  it("omits the attrs object from the console line when there are none", () => {
    const log = createLogger("svc");
    log.info("bare");

    expect(console.info).toHaveBeenCalledWith("[svc]", "INFO", "bare");
  });
});

describe("log level gating", () => {
  beforeEach(() => {
    clearEnv();
    exporter.reset();
    spyOnConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("suppresses sub-threshold logs from both OTLP and console", () => {
    setLogLevel("warn");
    const log = createLogger("svc");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    const records = exporter.getFinishedLogRecords();
    expect(records.map((r) => r.severityText)).toEqual(["WARN", "ERROR"]);
    expect(console.debug).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("silent drops everything, including errors", () => {
    setLogLevel("silent");
    const log = createLogger("svc");
    log.error("boom", {}, new Error("x"));

    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("lets setLogLevel() win over LOG_LEVEL", () => {
    setLogLevel("debug");
    process.env.LOG_LEVEL = "error";
    const log = createLogger("svc");
    log.debug("d");
    log.info("i");
    log.error("e");

    expect(getLogLevel()).toBe("debug");
    expect(exporter.getFinishedLogRecords().map((r) => r.severityText)).toEqual(
      ["DEBUG", "INFO", "ERROR"]
    );
  });
});

describe("getLogLevel resolution", () => {
  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  it.each([
    { deploymentEnv: undefined, name: "unset" },
    { deploymentEnv: "development", name: "development" },
    { deploymentEnv: "staging", name: "staging" },
    { deploymentEnv: "production", name: "production" },
  ])("defaults to info when DEPLOYMENT_ENV is $name", async ({
    deploymentEnv,
  }) => {
    vi.resetModules();
    delete process.env.LOG_LEVEL;
    if (deploymentEnv === undefined) {
      delete process.env.DEPLOYMENT_ENV;
    } else {
      process.env.DEPLOYMENT_ENV = deploymentEnv;
    }

    const fresh = await import("../src/logger");
    expect(fresh.getLogLevel()).toBe("info");
  });

  it("trims and lowercases a valid LOG_LEVEL", async () => {
    vi.resetModules();
    process.env.LOG_LEVEL = " DEBUG ";

    const fresh = await import("../src/logger");
    expect(fresh.getLogLevel()).toBe("debug");
  });

  it("treats an empty LOG_LEVEL as unset without warning", async () => {
    vi.resetModules();
    process.env.LOG_LEVEL = "   ";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const fresh = await import("../src/logger");
    expect(fresh.getLogLevel()).toBe("info");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once per distinct invalid normalized LOG_LEVEL", async () => {
    vi.resetModules();
    exporter.reset();
    process.env.LOG_LEVEL = " LOUD ";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const fresh = await import("../src/logger");
    expect(fresh.getLogLevel()).toBe("info");
    expect(fresh.getLogLevel()).toBe("info");
    process.env.LOG_LEVEL = "loud";
    expect(fresh.getLogLevel()).toBe("info");
    expect(warn).toHaveBeenCalledTimes(1);

    process.env.LOG_LEVEL = "verbose";
    expect(fresh.getLogLevel()).toBe("info");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
  });

  it("does not inspect invalid LOG_LEVEL when an override is active", async () => {
    vi.resetModules();
    process.env.LOG_LEVEL = "verbose";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const fresh = await import("../src/logger");
    fresh.setLogLevel("warn");
    expect(fresh.getLogLevel()).toBe("warn");
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects invalid JavaScript values without changing the override", async () => {
    vi.resetModules();
    const fresh = await import("../src/logger");
    fresh.setLogLevel("warn");

    expect(() =>
      Reflect.apply(fresh.setLogLevel, undefined, ["verbose"])
    ).toThrowError(
      "Invalid log level; expected one of: debug, info, warn, error, silent."
    );
    expect(fresh.getLogLevel()).toBe("warn");
  });
});
