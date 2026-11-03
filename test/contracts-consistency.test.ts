// Seam: contract consistency (ADR 0105, build plan M2.1). Parses the three transition tables
// in docs/spec.md section 9 and compares each with its contract file, and Machine 1's state table
// in section 3 with contracts/machine-1/idea.yaml (M3.6). A move in one and not
// the other fails, as does a state label the contracts do not know. Guards and evidence stay
// prose; people review those.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  MACHINE_1_DIR,
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
  const plain = cell.replace(/\s*\((pass|fail|redo)\)\s*$/, "");
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
  runner_only?: boolean;
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
  "prod_env_protected",
];

/** What the design track's merge adds to the shared set (D-258). */
const DESIGN_MERGE_EXTRA = ["unpicked_options_removed"];

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

  it.each(merging)("$file $move.from to $move.to has every check", ({ file, move }) => {
    // The design track's merge also checks that the PR no longer carries the folder of an option
    // Didi did not approve (D-258). Only design items have exploration options, so the code
    // track's merge keeps the shared set.
    const expected =
      file === "design.yaml" ? [...MERGE_GUARD, ...DESIGN_MERGE_EXTRA] : MERGE_GUARD;
    expect([...(move.guards ?? [])].sort()).toEqual([...expected].sort());
    expect(move.evidence).toEqual(
      expect.arrayContaining(["merge_check", "merge_commit"]),
    );
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
    const design = tableRows("Design track").find(
      (r) => r[0] === "In QA review to Verifying on staging (pass)",
    );
    expect(design?.[1]).toMatch(/option Didi did not approve/);
  });
});

describe("every track's dispatch out of its start state waits for blockers (contract consistency, D-268)", () => {
  // A design item Triage marks as blocked by another item waits for it like a code item, so the
  // dispatch moves of both tracks check blockers_done, and the spec's design row says so.
  it.each([
    { file: "code.yaml", move: "ready_for_dev->in_development" },
    {
      file: "design.yaml",
      move: "ready_for_design_exploration->in_design_exploration",
    },
  ])("$file $move checks blockers_done", ({ file, move }) => {
    const found = fileTransitions(file).find((t) => `${t.from}->${t.to}` === move);
    expect(found?.guards).toContain("blockers_done");
  });

  it("the spec's design dispatch row names the blockers", () => {
    const row = tableRows("Design track").find(
      (r) => r[0] === "Ready for design exploration to In design exploration",
    );
    expect(row?.[1]).toMatch(/every item blocking it is Done/);
  });
});

describe("runner-only moves are the ones a runner step owns (contract consistency, O-54)", () => {
  // The guards of the moves whose writes only their runner step makes: the Council's redo
  // (cancel, flag, counters, D-231) and the escalation's way back (counters, O-46, D-227).
  const RUNNER_GUARDS = [
    "council_redo_recorded",
    "council_decision_recorded",
    "didi_answer_recorded",
  ];

  it("marks a move runner_only exactly when one of those guards guards it", () => {
    for (const { file } of PAIRS) {
      for (const t of fileTransitions(file)) {
        const owned = (t.guards ?? []).some((g) => RUNNER_GUARDS.includes(g));
        expect(t.runner_only === true, `${file}:${t.from}->${t.to}`).toBe(owned);
      }
    }
  });
});

/** The rows of the Machine 1 table in docs/spec.md section 3: state label and "Moves on when". */
function machineOneRows(): { label: string; owner: string; moves: string }[] {
  const spec = readFileSync("docs/spec.md", "utf8");
  const start = spec.indexOf("\n## 3. Machine 1");
  const end = spec.indexOf("\n## 4.", start);
  if (start < 0 || end < 0) throw new Error("docs/spec.md section 3 not found");
  return spec
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter(([first]) => first !== "State" && !/^-+$/.test(first ?? ""))
    .map(([label = "", owner = "", moves = ""]) => ({ label, owner, moves }));
}

describe("Machine 1's contract matches the spec's section 3 table (contract consistency, M3.6)", () => {
  const parsed = parse(readFileSync(join(MACHINE_1_DIR, "idea.yaml"), "utf8")) as {
    states: Record<string, { label: string; owner: string }>;
    transitions: FileMove[];
  };
  const byLabel = new Map(
    Object.entries(parsed.states).map(([id, state]) => [state.label, { id, ...state }]),
  );

  it("declares every state of the table, with the table's owner", () => {
    const rows = machineOneRows();
    // "Parked or Rejected" is one row for two states (D-124).
    const labels = rows.flatMap((r) =>
      r.label === "Parked or Rejected" ? ["Parked", "Rejected"] : [r.label],
    );
    expect([...byLabel.keys()].sort()).toEqual([...labels].sort());
    for (const row of rows) {
      for (const label of row.label === "Parked or Rejected"
        ? ["Parked", "Rejected"]
        : [row.label]) {
        expect(byLabel.get(label)?.owner, label).toBe(row.owner);
      }
    }
  });

  it('declares only moves the table states, as "Goes to" the next state', () => {
    const rows = new Map(machineOneRows().map((r) => [r.label, r.moves]));
    const labelOf = (id: string) => parsed.states[id]?.label ?? id;
    for (const move of parsed.transitions) {
      expect(rows.get(labelOf(move.from)), `${move.from} to ${move.to}`).toContain(
        `Goes to ${labelOf(move.to)}`,
      );
    }
    expect(parsed.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      "plan_accepted->triage",
      "triage->handed_off",
    ]);
  });
});
