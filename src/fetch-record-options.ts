import {
  type RecordBody,
  type RecordCapture,
  type RecordCaptureReason,
  type RecordOptions,
  type RecordParser,
  type ResolvedRecordOptions,
  resolveRecordOptions,
} from "./record-options";

export type FetchRecordBody = RecordBody;
export type FetchRecordCapture = RecordCapture;
export type FetchCaptureReason = RecordCaptureReason;
export type FetchRecordParser<T> = RecordParser<T>;

export interface FetchRequestRecord {
  body: FetchRecordBody | null;
  capture: FetchRecordCapture;
  /** Unix timestamps in milliseconds. */
  finishedAt: number;
  headers: Record<string, string[]>;
  method: string;
  options: Record<string, string | boolean>;
  startedAt: number;
  url: string;
}

export interface FetchResponseRecord {
  body: FetchRecordBody | null;
  capture: FetchRecordCapture;
  finishedAt: number;
  headers: Record<string, string[]>;
  ok: boolean;
  redirected: boolean;
  startedAt: number;
  status: number;
  statusText: string;
  type: string;
  url: string;
}

export type FetchRecordOptions = RecordOptions<
  FetchRequestRecord,
  FetchResponseRecord
>;
export type ResolvedFetchRecordOptions = ResolvedRecordOptions<
  FetchRequestRecord,
  FetchResponseRecord
>;

export const resolveFetchRecordOptions = (
  options: false | FetchRecordOptions | undefined
): ResolvedFetchRecordOptions | undefined => resolveRecordOptions(options);
