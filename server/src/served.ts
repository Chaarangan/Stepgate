import { watch, readFileSync, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StepfileInvalid } from "./engine/errors.ts";
import { load } from "./engine/load.ts";
import type { Stepfile } from "./engine/types.ts";

/** One stepfile a server offers as a tool: loaded, or refused by its last edit, which a call to it then reports. */
export type ServedEntry = { id: string; stepfile: Stepfile; problem: null } | { id: string; stepfile: null; problem: StepfileInvalid };

/** The stepfiles a server offers; `--watch` changes them while it runs, and `onChange` returns its own unsubscribe. */
export type Served = {
  entries: () => ServedEntry[];
  onChange: (listener: () => void) => () => void;
  close: () => void;
};

/** Stepfiles loaded once at start, which never change. */
export function fixedStepfiles(stepfiles: Stepfile[]): Served {
  const entries = stepfiles.map((stepfile): ServedEntry => ({ id: stepfile.document.id, stepfile, problem: null }));
  return { entries: () => entries, onChange: () => () => undefined, close: () => undefined };
}

function reload(file: string, previousId: string): ServedEntry {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { id: previousId, stepfile: null, problem: new StepfileInvalid([{ path: "", message: `cannot read ${file}: ${(error as Error).message}` }]) };
  }
  try {
    const stepfile = load(text);
    return { id: stepfile.document.id, stepfile, problem: null };
  } catch (error) {
    if (error instanceof StepfileInvalid) {
      return { id: previousId, stepfile: null, problem: error };
    }
    throw error;
  }
}

/**
 * Loads each file, raising StepfileInvalid at start as without `--watch`, then reloads a file whenever it changes.
 * It watches each file's folder, because editors often save by replacing the file, which ends a watch on the file itself.
 */
export function watchStepfiles(files: Array<string | URL>): Served {
  const paths = files.map((file) => (typeof file === "string" ? file : fileURLToPath(file)));
  const entries = paths.map((path): ServedEntry => {
    const stepfile = load(readFileSync(path, "utf8"));
    return { id: stepfile.document.id, stepfile, problem: null };
  });
  const listeners = new Set<() => void>();
  const pending = new Map<number, NodeJS.Timeout>();
  const changed = (index: number) => {
    clearTimeout(pending.get(index));
    // Editors write a file in several events; reload once they settle.
    pending.set(index, setTimeout(() => {
      pending.delete(index);
      entries[index] = reload(paths[index] as string, (entries[index] as ServedEntry).id);
      for (const listener of listeners) {
        listener();
      }
    }, 50));
  };
  const watchers: FSWatcher[] = paths.map((path, index) => watch(dirname(path), (_event, name) => {
    if (name === basename(path)) {
      changed(index);
    }
  }));
  return {
    entries: () => [...entries],
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close: () => {
      for (const watcher of watchers) {
        watcher.close();
      }
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
    },
  };
}
