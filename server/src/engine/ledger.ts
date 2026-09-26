import { canonicalHash } from "./identity.ts";
import type { RunContext, JsonObject, LedgerRecord } from "./types.ts";

export type AppendRecord = (type: string, fields: JsonObject) => Promise<void>;

/** Returns an appender that numbers, timestamps and hash-chains each record before passing it to the sink. */
export function createLedger(sink: RunContext["ledger"]): AppendRecord {
  let seq = 0;
  let prev: string | null = null;
  return async (type, fields) => {
    const record: LedgerRecord = { ...fields, seq, type, at: new Date().toISOString(), prev };
    seq += 1;
    prev = canonicalHash(record);
    await sink(record);
  };
}

/** True when every record's `prev` matches the hash of the record before it. */
export function verifyLedger(records: LedgerRecord[]): boolean {
  return records.every((record, index) => {
    const previous = records[index - 1];
    return record.prev === (previous === undefined ? null : canonicalHash(previous));
  });
}
