// Reads the contract files (ADR 0105). Parsing stays out of the core: this adapter parses the
// YAML in contracts/<machine>/ and hands every file, untouched, to the core's validateContracts,
// which holds every rule, including the shape of each file and the one-file-per-state rule.
// The only thing decided here is which file is the escalation file, and that comes from the
// file name (escalation.yaml), never from what the file says about itself.
// A YAML syntax error throws, naming the file: there is no object to validate.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import type { RawContractFile } from "../../core/contracts.ts";

export const MACHINE_2_DIR = "contracts/machine-2";

/** The one file whose transitions may use `from: any` and `to: return`. */
export const ESCALATION_FILE = "escalation.yaml";

export interface LoadedContractFiles {
  /** The plain object for the core's validateContracts. */
  raw: { version: string; contentHash: string; files: RawContractFile[] };
  /** SHA-256 of the file bytes, in file-name order. */
  contentHash: string;
  files: string[];
}

/**
 * Loads every .yaml file in `dir`, in file-name order. `version` is the spec version (the git
 * commit of docs/spec.md and contracts/); callers pass it in rather than this adapter shelling
 * out to git.
 */
export function loadContractFiles(
  version: string,
  dir: string = MACHINE_2_DIR,
): LoadedContractFiles {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const hash = createHash("sha256");
  const files: RawContractFile[] = [];

  for (const name of names) {
    const bytes = readFileSync(join(dir, name));
    hash.update(bytes);
    let data: unknown;
    try {
      data = parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`${name} is not valid YAML: ${(error as Error).message}`);
    }
    files.push({ name, escalation: name === ESCALATION_FILE, data });
  }

  const contentHash = hash.digest("hex");
  return { raw: { version, contentHash, files }, contentHash, files: names };
}
