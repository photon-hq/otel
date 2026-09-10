import { Buffer } from "node:buffer";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import type {
  FetchCaptureReason,
  FetchRecordBody,
  FetchRecordCapture,
  ResolvedFetchRecordOptions,
} from "./fetch-record-options";

export interface CapturedBody {
  body: FetchRecordBody | null;
  capture: FetchRecordCapture;
}

function encodeBody(chunks: Uint8Array[], byteLength: number): FetchRecordBody {
  const bytes = Buffer.concat(chunks, byteLength);
  try {
    // Preserve a UTF-8 BOM too: ignoreBOM means it is returned as a character.
    const data = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return { data, encoding: "utf8", byteLength };
  } catch {
    return { data: bytes.toString("base64"), encoding: "base64", byteLength };
  }
}

/** Owns only the clone's branch. Stopping it never aborts the real fetch. */
export class FetchBodyCapture {
  readonly result: Promise<CapturedBody>;
  private resolve!: (result: CapturedBody) => void;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly chunks: Uint8Array[] = [];
  private byteLength = 0;
  private available = false;
  private settled = false;
  private signal?: AbortSignal;
  private readonly abort = (): void => this.stop("abort");

  constructor(
    source: Request | Response | undefined,
    options: ResolvedFetchRecordOptions,
    signal?: AbortSignal,
    reason?: FetchCaptureReason
  ) {
    this.result = new Promise((resolve) => {
      this.resolve = resolve;
    });
    if (reason) {
      this.stop(reason);
      return;
    }
    if (!source) {
      this.stop("unavailable_body");
      return;
    }
    this.start(source, options, signal);
  }

  private start(
    source: Request | Response,
    options: ResolvedFetchRecordOptions,
    signal?: AbortSignal
  ): void {
    try {
      if (source.bodyUsed) {
        this.stop("unavailable_body");
        return;
      }
      // Clone before reading source.body: on Bun, materializing a Request's
      // body first can cause clone() to steal the original branch's bytes.
      const clone = source.clone();
      if (!clone.body) {
        this.finish();
        return;
      }
      this.reader = clone.body.getReader();
      this.available = true;
    } catch {
      this.stop("unavailable_body");
      return;
    }
    this.signal = signal;
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) {
      this.stop("abort");
      return;
    }
    if (Number.isFinite(options.bodyTimeoutMs)) {
      this.timer = setTimeout(
        () => this.stop("timeout"),
        options.bodyTimeoutMs
      );
    }
    if (options.maxBodyBytes === 0) {
      this.stop("size_limit");
      return;
    }
    // read() handles its own rejection, including cancellation races.
    this.read(options.maxBodyBytes).catch(() => this.stop("read_failure"));
  }

  private async read(maxBodyBytes: number): Promise<void> {
    const reader = this.reader;
    if (!reader) {
      this.stop("unavailable_body");
      return;
    }
    try {
      while (!this.settled) {
        const { done, value } = await reader.read();
        if (this.settled) {
          return;
        }
        if (done) {
          this.finish();
          return;
        }
        const remaining = maxBodyBytes - this.byteLength;
        const length = Math.min(value.byteLength, remaining);
        if (length > 0) {
          // Copy: a stream producer may reuse or mutate the original buffer.
          this.chunks.push(value.slice(0, length));
          this.byteLength += length;
        }
        if (value.byteLength > remaining) {
          this.stop("size_limit");
        }
      }
    } catch {
      this.stop(this.signal?.aborted ? "abort" : "read_failure");
    } finally {
      reader.releaseLock();
    }
  }

  stop(reason: FetchCaptureReason): void {
    this.finish(reason);
  }

  private finish(reason?: FetchCaptureReason): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.abort);
    if (reason && this.reader) {
      // A tee cancellation can wait for the other branch indefinitely.
      this.reader.cancel().catch(() => undefined);
    }
    const capture: FetchRecordCapture = {
      capturedBytes: this.byteLength,
      complete: reason === undefined,
      ...(reason ? { reason } : {}),
    };
    this.resolve({
      body: this.available ? encodeBody(this.chunks, this.byteLength) : null,
      capture,
    });
    this.chunks.length = 0;
  }
}
