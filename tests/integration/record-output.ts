import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface OtlpValue {
  arrayValue?: { values?: OtlpValue[] };
  boolValue?: boolean;
  doubleValue?: number;
  intValue?: number | string;
  kvlistValue?: { values?: { key: string; value: OtlpValue }[] };
  stringValue?: string;
}

export interface WireLog {
  body?: OtlpValue;
  eventName?: string;
  spanId?: string;
  traceId?: string;
}

export function decode(value: OtlpValue): unknown {
  if (value.kvlistValue) {
    return Object.fromEntries(
      (value.kvlistValue.values ?? []).map((entry) => [
        entry.key,
        decode(entry.value),
      ])
    );
  }
  if (value.arrayValue) {
    return (value.arrayValue.values ?? []).map(decode);
  }
  if (value.intValue !== undefined) {
    return Number(value.intValue);
  }
  return value.stringValue ?? value.boolValue ?? value.doubleValue ?? null;
}

export async function readLogs(nonce: string): Promise<WireLog[]> {
  const output =
    process.env.COLLECTOR_OUTPUT_DIR ?? join(import.meta.dirname, "output");
  const data = await readFile(join(output, "logs.json"), "utf8");
  const result: WireLog[] = [];
  for (const line of data.trim().split("\n")) {
    try {
      const parsed = JSON.parse(line) as {
        resourceLogs?: {
          resource?: { attributes?: { key: string; value: OtlpValue }[] };
          scopeLogs?: { logRecords?: WireLog[] }[];
        }[];
      };
      for (const resource of parsed.resourceLogs ?? []) {
        if (
          !resource.resource?.attributes?.some(
            (attribute) =>
              attribute.key === "test.record.nonce" &&
              attribute.value.stringValue === nonce
          )
        ) {
          continue;
        }
        for (const scope of resource.scopeLogs ?? []) {
          result.push(...(scope.logRecords ?? []));
        }
      }
    } catch {
      // The Collector may currently be appending this line.
    }
  }
  return result;
}
