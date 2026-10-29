// Reads the contract files (ADR 0105). Parsing stays out of the core: this adapter turns the
// YAML in contracts/<machine>/ into one plain object and hands it to the core's
// validateContracts, which holds every semantic rule. Beyond YAML parsing, the only thing
// rejected here is a state id declared in two files, because a mechanical merge would silently
// drop one of the declarations.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const MACHINE_2_DIR = "contracts/machine-2";

interface RawFile {
  part?: unknown;
  states?: Record<string, unknown>;
  transitions?: unknown[];
}

export interface LoadedContractFiles {
  /** The merged plain object for the core's validateContracts. */
  raw: unknown;
  /** SHA-256 of the file bytes, in file-name order. */
  contentHash: string;
  files: string[];
}

/**
 * Loads every .yaml file in `dir`, in file-name order, into one raw contracts object.
 * `version` is the spec version (the git commit of docs/spec.md and contracts/); callers pass
 * it in rather than this adapter shelling out to git.
 */
export function loadContractFiles(
  version: string,
  dir: string = MACHINE_2_DIR,
): LoadedContractFiles {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const hash = createHash("sha256");
  const states: Record<string, unknown> = {};
  const declaredIn = new Map<string, string>();
  const transitions: unknown[] = [];

  for (const name of files) {
    const bytes = readFileSync(join(dir, name));
    hash.update(bytes);
    const parsed = (parse(bytes.toString("utf8")) ?? {}) as RawFile;
    const escalation = parsed.part === "escalation";
    for (const [id, state] of Object.entries(parsed.states ?? {})) {
      const already = declaredIn.get(id);
      if (already) {
        throw new Error(
          `State ${id} is declared in both ${already} and ${name}; each state lives in exactly one file`,
        );
      }
      declaredIn.set(id, name);
      states[id] = state;
    }
    for (const transition of parsed.transitions ?? []) {
      transitions.push(
        escalation && typeof transition === "object" && transition !== null
          ? { ...transition, escalation: true }
          : transition,
      );
    }
  }

  const contentHash = hash.digest("hex");
  return { raw: { version, contentHash, states, transitions }, contentHash, files };
}
