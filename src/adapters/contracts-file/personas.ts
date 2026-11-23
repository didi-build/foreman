// Reads the persona files (ADR 0119, D-455 to D-457): contracts/personas/shared.yaml, the shared
// base every persona carries, and one <id>.yaml per persona. Parsing stays out of the core: this
// adapter parses the YAML and hands every file's data, untouched, to the core's validatePersonas,
// which holds every rule. A YAML syntax error throws, naming the file and never its content. The
// files are read through ../bundle-files/files.ts: from disk, or from a flow's bundle (O-121),
// which carries all of contracts/.
//
// No run reads the personas yet. ADR 0119's slice 2 composes them into each run's instructions.
import { join } from "node:path";
import { parse, YAMLParseError } from "yaml";

import {
  SHARED_FILE_ID,
  validatePersonas,
  type Personas,
  type RawPersonaFiles,
} from "../../core/personas.ts";
import { listBundledFolder, readBundledFile } from "../bundle-files/files.ts";

export const PERSONAS_DIR = "contracts/personas";

const YAML_FILE = ".yaml";

function parseFile(dir: string, name: string): unknown {
  try {
    return parse(readBundledFile(join(dir, name)).toString("utf8")) as unknown;
  } catch (error) {
    const line =
      error instanceof YAMLParseError && error.linePos
        ? ` at line ${error.linePos[0].line}`
        : "";
    throw new Error(`${name} is not valid YAML${line}`);
  }
}

/** Parses every `.yaml` file in `dir`: the shared base, and each other file as a persona. */
export function loadPersonaFiles(dir: string = PERSONAS_DIR): RawPersonaFiles {
  const names = listBundledFolder(dir)
    .filter((name) => name.endsWith(YAML_FILE))
    .sort();
  const personas: Record<string, unknown> = {};
  let shared: unknown;
  for (const name of names) {
    const id = name.slice(0, -YAML_FILE.length);
    if (id === SHARED_FILE_ID) shared = parseFile(dir, name);
    else personas[id] = parseFile(dir, name);
  }
  return { shared, personas };
}

/** Loads and checks the persona files, or throws with every problem. */
export function readPersonas(dir: string = PERSONAS_DIR): Personas {
  const { personas, problems } = validatePersonas(loadPersonaFiles(dir));
  if (!personas)
    throw new Error(`The persona files are invalid: ${problems.join("; ")}`);
  return personas;
}
