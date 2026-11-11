// Reads the contract files (ADR 0105). Parsing stays out of the core: this adapter parses the
// YAML in contracts/<machine>/ and hands every file, untouched, to the core's validateContracts,
// which holds every rule, including the shape of each file and the one-file-per-state rule.
// The only thing decided here is which file is the escalation file, and that comes from the
// file name (escalation.yaml), never from what the file says about itself.
// A YAML syntax error throws, naming the file: there is no object to validate.
// The files are read through ../bundle-files/files.ts: from disk, or from a flow's bundle (O-121).
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse } from "yaml";

import type { RawContractFile } from "../../core/contracts.ts";
import { listBundledFolder, readBundledFile } from "../bundle-files/files.ts";

export const MACHINE_2_DIR = "contracts/machine-2";

/** Machine 1, the idea machine (build plan M3.6). Its states and Machine 2's form one contract set. */
export const MACHINE_1_DIR = "contracts/machine-1";

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
  const names = listBundledFolder(dir)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const hash = createHash("sha256");
  const files: RawContractFile[] = [];

  for (const name of names) {
    const bytes = readBundledFile(join(dir, name));
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

/**
 * Loads the contract files of both machines, Machine 1's first, as one set: the library reads one
 * set, and an idea in Triage escalates through Machine 2's escalation file like any node. The
 * content hash covers every file, in that order. File names must differ across the two folders.
 */
export function loadAllContractFiles(
  version: string,
  dirs: readonly string[] = [MACHINE_1_DIR, MACHINE_2_DIR],
): LoadedContractFiles {
  const hash = createHash("sha256");
  const files: RawContractFile[] = [];
  const names: string[] = [];
  for (const dir of dirs) {
    const loaded = loadContractFiles(version, dir);
    hash.update(loaded.contentHash);
    files.push(...loaded.raw.files);
    names.push(...loaded.files);
  }
  if (new Set(names).size !== names.length) {
    throw new Error("Two contract folders hold a file of the same name");
  }
  const contentHash = hash.digest("hex");
  return { raw: { version, contentHash, files }, contentHash, files: names };
}

/** The task types file (ADR 0114 section 1). The core's validateTaskTypes checks its shape. */
export const TASK_TYPES_FILE = "contracts/task-types.yaml";

/** Parses the task types file. A YAML syntax error throws, naming the file. */
export function loadTaskTypesFile(path: string = TASK_TYPES_FILE): unknown {
  const text = readBundledFile(path).toString("utf8");
  try {
    return parse(text) as unknown;
  } catch (error) {
    throw new Error(`${path} is not valid YAML: ${(error as Error).message}`);
  }
}
