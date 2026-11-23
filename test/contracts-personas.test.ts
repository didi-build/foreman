// Seam: unit, repo guard (ADR 0119, D-455 to D-457, ADR 0105). The persona files in
// contracts/personas/ load through the contracts-file adapter and pass the core's check: the
// shared base and exactly the four first personas, each with its six parts. A YAML error names
// the file. Each run's composed instructions are checked with the bot files
// (src/adapters/contracts-file/bot-files.test.ts, ADR 0119 slice 2).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadPersonaFiles,
  PERSONAS_DIR,
  readPersonas,
} from "../src/adapters/contracts-file/personas.ts";
import { validatePersonas } from "../src/core/personas.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("contracts/personas (unit: repo guard, ADR 0119)", () => {
  it("holds the shared base and the four first personas, and they pass the check", () => {
    const raw = loadPersonaFiles();
    expect(Object.keys(raw.personas)).toEqual([
      "designer",
      "developer",
      "product",
      "quality",
    ]);
    expect(validatePersonas(raw).problems).toEqual([]);
  });

  it("gives every persona a one-line lens and five non-empty lists (D-455)", () => {
    const { personas, shared } = readPersonas(PERSONAS_DIR);
    for (const persona of Object.values(personas)) {
      expect(persona.lens).not.toMatch(/\n/);
      for (const part of [
        persona.caresMostAbout,
        persona.craftStandards,
        persona.watchesFor,
        persona.never,
        persona.needsToKnow,
      ]) {
        expect(part.length).toBeGreaterThan(0);
      }
    }
    expect(shared.userFlow.length).toBeGreaterThan(0);
  });

  it("refuses a file that is not valid YAML, naming the file and the line only", () => {
    const dir = mkdtempSync(join(tmpdir(), "personas-"));
    dirs.push(dir);
    writeFileSync(join(dir, "shared.yaml"), "user_flow: [unclosed\n");
    expect(() => loadPersonaFiles(dir)).toThrow(/^shared\.yaml is not valid YAML/);
  });

  it("throws with every problem when the files do not pass the check", () => {
    const dir = mkdtempSync(join(tmpdir(), "personas-"));
    dirs.push(dir);
    writeFileSync(join(dir, "product.yaml"), "persona: product\n");
    expect(() => readPersonas(dir)).toThrow(
      /^The persona files are invalid: shared\.yaml is missing; product\.yaml cares_most_about/,
    );
  });
});
