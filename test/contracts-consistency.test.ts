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
import { GUARD_NAMES } from "../src/core/guards/index.ts";

const PAIRS: { file: string; heading: string }[] = [
  { file: "code.yaml", heading: "Code, infrastructure and docs tracks" },
  { file: "design.yaml", heading: "Design track" },
  { file: "escalation.yaml", heading: "Escalation" },
];

/**
 * Moves the spec describes only in a row's prose fallback, not as a table row. Each is pinned
 * here with the row it comes from and the spec's own words, and the files' fallback_move set
 * must equal this list exactly, so a fallback move can be neither invented nor lost.
 */
const FALLBACK_MOVES: { file: string; move: string; row: string; words: string }[] = [
  {
    file: "code.yaml",
    move: "verifying_on_staging->in_development",
    row: "Verifying on staging to Done",
    words: "if the check fails, the item goes back to In development",
  },
  {
    file: "design.yaml",
    move: "waiting_for_didi->in_design_exploration",
    row: "Waiting for Didi to Writing spec",
    words:
      "if Didi asks for changes or rejects, the item returns to In design exploration",
  },
  {
    file: "design.yaml",
    move: "verifying_on_staging->building_components",
    row: "Verifying on staging to Done",
    words: "if the check fails, the item goes back to Building components",
  },
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

/** The rows of the markdown table that follows a bold heading in section 9, as cell lists. */
function tableRows(heading: string): string[][] {
  const spec = readFileSync("docs/spec.md", "utf8");
  const start = spec.indexOf("\n## 9.");
  const end = spec.indexOf("\n## 10.", start);
  if (start < 0 || end < 0) throw new Error("docs/spec.md section 9 not found");
  const section = spec.slice(start, end);
  const headingAt = section.indexOf(`**${heading}**`);
  if (headingAt < 0) throw new Error(`heading ${heading} not found in section 9`);
  const lines = section.slice(headingAt).split("\n");
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines.slice(1)) {
    if (!line.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const first = cells[0] ?? "";
    if (first === "Transition" || /^-+$/.test(first)) continue;
    rows.push(cells);
  }
  if (rows.length === 0) throw new Error(`no rows under ${heading}`);
  return rows;
}

const tableCells = (heading: string): string[] =>
  tableRows(heading).map((cells) => cells[0] ?? "");

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

interface FileMove {
  from: string;
  to: string;
  fallback_move?: boolean;
  trigger?: string;
  guards?: string[];
  evidence?: string[];
}

function fileTransitions(file: string): FileMove[] {
  const parsed = parse(readFileSync(join(MACHINE_2_DIR, file), "utf8")) as {
    transitions: FileMove[];
  };
  return parsed.transitions;
}

/** The moves of one contract file that the spec states as table rows. */
const fileMoves = (file: string): Set<string> =>
  new Set(
    fileTransitions(file)
      .filter((t) => t.fallback_move !== true)
      .map((t) => `${t.from}->${t.to}`),
  );

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

describe("fallback moves are pinned to the spec's prose (contract consistency, ADR 0105)", () => {
  it("the files mark exactly the pinned fallback moves", () => {
    const marked = PAIRS.flatMap(({ file }) =>
      fileTransitions(file)
        .filter((t) => t.fallback_move === true)
        .map((t) => `${file}:${t.from}->${t.to}`),
    ).sort();
    expect(marked).toEqual(FALLBACK_MOVES.map((f) => `${f.file}:${f.move}`).sort());
  });

  it.each(FALLBACK_MOVES)(
    "$file $move comes from the $row row's fallback",
    ({ file, row, words }) => {
      const heading = PAIRS.find((pair) => pair.file === file)?.heading ?? "";
      const cells = tableRows(heading).find((r) => r[0] === row);
      expect(cells, `row ${row} under ${heading}`).toBeDefined();
      expect(cells?.at(-1)).toContain(words);
    },
  );
});

/** The merge guard (build plan M3.3, D-218): what every move on which the runner merges carries. */
const MERGE_GUARD = [
  "qa_verdict_independent_on_head",
  "docs_updated_or_none",
  "ci_green_on_head",
  "no_merge_conflict_on_head",
  "qa_rounds_below_cap",
  "privileged_paths_approved",
];

describe("every merging move carries the merge guard (contract consistency, D-218)", () => {
  // A merging move is one whose spec row says the runner merges the PR.
  const merging = PAIRS.flatMap(({ file }) =>
    fileTransitions(file)
      .filter((t) => /The runner then merges the PR/.test(String(t.trigger)))
      .map((t) => ({ file, move: t })),
  );

  it("finds the merging move of both tracks", () => {
    expect(merging.map(({ file, move }) => `${file}:${move.from}->${move.to}`)).toEqual(
      [
        "code.yaml:in_qa_review->verifying_on_staging",
        "design.yaml:in_qa_review->verifying_on_staging",
      ],
    );
  });

  it.each(merging)("$file $move.from to $move.to has every check", ({ move }) => {
    expect(move.guards).toEqual(expect.arrayContaining(MERGE_GUARD));
    expect(move.evidence).toEqual(
      expect.arrayContaining(["merge_check", "merge_commit"]),
    );
  });

  it("checks production protection where the code track deploys on push to main", () => {
    const code = merging.find(({ file }) => file === "code.yaml");
    expect(code?.move.guards).toContain("prod_env_protected");
  });

  it("the spec names the merge guard's checks in both merging rows", () => {
    for (const { heading } of PAIRS.slice(0, 2)) {
      const row = tableRows(heading).find(
        (r) => r[0] === "In QA review to Verifying on staging (pass)",
      );
      expect(row?.[1], heading).toMatch(/no merge conflict/);
      expect(row?.[1], heading).toMatch(/round cap/);
      expect(row?.[1], heading).toMatch(/privileged path/);
    }
  });
});
