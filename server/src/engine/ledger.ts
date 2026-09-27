import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash } from "./identity.ts";
import type { JsonObject, LedgerRecord } from "./types.ts";

export type AppendRecord = (type: string, fields: JsonObject) => Promise<void>;

/** Receives each record exactly as it was hashed, so what it stores verifies. */
export type LedgerSink = (record: LedgerRecord) => void | Promise<void>;

/** Returns an appender that numbers, timestamps and hash-chains each record, tagging it with the run and stepfile, before passing it to the sink. */
export function createLedger(sink: LedgerSink, run: { run: string; stepfile: string }): AppendRecord {
  let seq = 0;
  let prev: string | null = null;
  return async (type, fields) => {
    const record: LedgerRecord = { ...fields, ...run, seq, type, at: new Date().toISOString(), prev };
    seq += 1;
    prev = canonicalHash(record);
    await sink(record);
  };
}

/** Where a chain breaks: the first record whose `seq`, `prev` or run does not follow from the one before, or null when it is intact. */
export function firstBreak(records: LedgerRecord[]): { seq: number; reason: string } | null {
  for (const [index, record] of records.entries()) {
    const previous = records[index - 1];
    if (record.seq !== index) {
      return { seq: index, reason: `expected seq ${index}, found ${String(record.seq)}` };
    }
    if (record.prev !== (previous === undefined ? null : canonicalHash(previous))) {
      return { seq: index, reason: "prev does not match the hash of the record before it" };
    }
    if (previous !== undefined && (record.run !== previous.run || record.stepfile !== previous.stepfile)) {
      return { seq: index, reason: "the record belongs to a different run" };
    }
  }
  return null;
}

/** Writes one JSON-lines file per run, named `<stepfile>-<run>.jsonl`. */
export function directorySink(directory: string): LedgerSink {
  mkdirSync(directory, { recursive: true });
  return (record) => appendFileSync(join(directory, `${String(record.stepfile)}-${String(record.run)}.jsonl`), `${JSON.stringify(record)}\n`);
}

/** Writes every run's records as JSON lines to one stream, such as standard error; each carries its run. */
export function streamSink(stream: NodeJS.WritableStream): LedgerSink {
  return (record) => void stream.write(`${JSON.stringify(record)}\n`);
}
