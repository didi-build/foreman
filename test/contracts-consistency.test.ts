// Seam: contract consistency (ADR 0105, build plan M2.1). Parses the three transition tables
// in docs/spec.md section 9 and compares each with its contract file. A move in one and not
// the other fails, as does a state label the contracts do not know. Guards and evidence stay
// prose; people review those.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  MACHINE_2_DIR,
  loadContractFiles,
} from "../src/adapters/contracts-file/load.ts";
import { validateContracts } from "../src/core/contracts.ts";
import { GUARD_NAMES } from "./lib/guard-names.ts";

const PAIRS: { file: string; heading: string }[] = [
  { file: "code.yaml", heading: "Code, infrastructure and docs tracks" },
  { file: "design.yaml", heading: "Design track" },
  { file: "escalation.yaml", heading: "Escalation" },
];

/** Label to state id, from the validated contracts plus the two escalation phrases. */
function labelMap(): Map<string, string> {
  const loaded = loadContractFiles("0".repeat(40));
  const { contracts, problems } = validateContracts(loaded.raw, GUARD_NAMES);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const map = new Map<string, string>();
  for (const [id, state] of Object.entries(contracts?.states ?? {})) {
    map.set(state.label ?? id, id);
  }
  map.set("Any state", "any");
  map.set("the state it came from", "return");
  return map;
}

/** The first-column cells of the markdown table that follows a bold heading in section 9. */
function tableCells(heading: string): string[] {
  const spec = readFileSync("docs/spec.md", "utf8");
  const start = spec.indexOf("\n## 9.");
  const end = spec.indexOf("\n## 10.", start);
  if (start < 0 || end < 0) throw new Error("docs/spec.md section 9 not found");
  const section = spec.slice(start, end);
  const headingAt = section.indexOf(`**${heading}**`);
  if (headingAt < 0) throw new Error(`heading ${heading} not found in section 9`);
  const lines = section.slice(headingAt).split("\n");
  const cells: string[] = [];
  let inTable = false;
  for (const line of lines.slice(1)) {
    if (!line.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const first = (line.split("|")[1] ?? "").trim();
    if (first === "Transition" || /^-+$/.test(first)) continue;
    cells.push(first);
  }
  if (cells.length === 0) throw new Error(`no rows under ${heading}`);
  return cells;
}

/** "Blocked to Ready for dev" into from and to ids. Labels may themselves contain " to ". */
function parseCell(cell: string, labels: Map<string, string>): string {
  const plain = cell.replace(/\s*\((pass|fail)\)\s*$/, "");
  const known = [...labels.keys()].sort((a, b) => b.length - a.length);
  for (const from of known) {
    if (!plain.startsWith(`${from} to `)) continue;
    const rest = plain.slice(from.length + " to ".length);
    const to = labels.get(rest);
    if (to) return `${labels.get(from)}->${to}`;
  }
  throw new Error(`Cannot map spec row "${cell}" to contract states`);
}

/** The non-fallback moves of one contract file. Fallback moves live in the spec's prose. */
function fileMoves(file: string): Set<string> {
  const parsed = parse(readFileSync(join(MACHINE_2_DIR, file), "utf8")) as {
    transitions: { from: string; to: string; fallback_move?: boolean }[];
  };
  return new Set(
    parsed.transitions
      .filter((t) => t.fallback_move !== true)
      .map((t) => `${t.from}->${t.to}`),
  );
}

describe("contracts match the spec's transition tables (contract consistency, ADR 0105)", () => {
  it.each(PAIRS)("$file matches the $heading table", ({ file, heading }) => {
    const labels = labelMap();
    const specMoves = new Set(
      tableCells(heading).map((cell) => parseCell(cell, labels)),
    );
    const contractMoves = fileMoves(file);
    const specOnly = [...specMoves].filter((move) => !contractMoves.has(move));
    const contractOnly = [...contractMoves].filter((move) => !specMoves.has(move));
    expect(specOnly, `in the spec but not in ${file}`).toEqual([]);
    expect(contractOnly, `in ${file} but not in the spec table`).toEqual([]);
  });
});
