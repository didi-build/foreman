// Scores one model answer to one case (ADR 0117, D-427). An answer is first put through the
// runner's own check for its role; one the runner would refuse is `unusable`, whatever it says.
// A usable answer is `correct` when it meets the case's expected answer under the role's rule
// below, and `wrong` otherwise. No model judges an answer.
//
// - QA: `parseVerdict` with the case's evidence ids, as the image checks a verdict. Then ADR 0112's
//   citation rule, which the runner is to apply when it records a verdict: every finding names a
//   file at the head commit and lines inside it. A pass case wants `pass`. A fail case wants
//   `fail` and at least one finding on a file the case accepts.
// - Triage: `checkTriageAnswer` against the case's repo map, as the runner checks an answer
//   before it creates anything. Then the items: as many as expected, each expected item matched
//   to its own answer item that covers all its paths, each matched item blocked by exactly the
//   matched items the case names, and needsDidi and hold as expected.
// - The Council: the escalation schema and `readEscalationAnswer`, as the runner reads an answer.
//   Then where the item goes: the runner's rule (`council_decision_recorded`) keeps it with the
//   Council only for `resolve` with both flags false, and sends it to Didi otherwise. A case
//   routed to Didi also names the reasons that count: an answer that reaches Didi for another
//   reason is wrong.
//
// The answer is the run's final text: the model's JSON, or in tool mode the answer tool's input as
// JSON (src/agent-images/claude-api/loop.ts).
import { parseVerdict } from "../agent-images/claude-api/verdict.ts";
import { readEscalationAnswer, type EscalationAnswer } from "../core/council.ts";
import { COUNCIL_CANNOT_RESOLVE } from "../core/guards/escalation.ts";
import { outputProblem } from "../core/output-schema.ts";
import { checkTriageAnswer, type TriageItem } from "../core/triage.ts";
import type {
  CouncilCase,
  DidiReason,
  EvalCase,
  ExpectedItem,
  QaCase,
  TriageCase,
} from "./cases.ts";
import type { CaseRun, CouncilRun, QaRun, TriageRun } from "./inputs.ts";

export type ScoreOutcome = "correct" | "wrong" | "unusable";

export interface Score {
  outcome: ScoreOutcome;
  /** Why, in one sentence. Names fields and paths, never quotes the answer's text. */
  detail: string;
}

const score = (outcome: ScoreOutcome, detail: string): Score => ({ outcome, detail });

function json(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

/** How many lines QA's read tool numbers in a file: every `\n`-separated line. */
const lineCount = (text: string): number => text.split("\n").length;

function scoreQa(c: QaCase, run: QaRun, text: string): Score {
  const parsed = parseVerdict(text, run.evidenceIds);
  if ("problem" in parsed)
    return score("unusable", `the verdict is unusable: ${parsed.problem}`);
  const { verdict } = parsed;
  for (const finding of verdict.findings) {
    const file = run.files.get(finding.path);
    if (file === undefined || finding.endLine > lineCount(file)) {
      return score(
        "unusable",
        "a finding cites a file or lines that are not at the head commit (ADR 0112)",
      );
    }
  }
  if (verdict.verdict !== c.expected.verdict) {
    return score(
      "wrong",
      `the verdict is ${verdict.verdict}, and ${c.expected.verdict} is right`,
    );
  }
  if (c.expected.verdict === "pass") return score("correct", "a pass, as expected");
  const accepted = c.expected.findingIn;
  if (!verdict.findings.some((f) => accepted.includes(f.path))) {
    return score("wrong", `a fail, but no finding is on ${accepted.join(" or ")}`);
  }
  return score("correct", `a fail with a finding on ${accepted.join(" or ")}`);
}

/** True when one of the item's paths is the path itself or a folder that holds it. */
function covers(item: TriageItem, path: string): boolean {
  return item.pathsInScope.some((raw) => {
    const scope = raw.trim().replace(/\/+$/, "");
    return scope === path || path.startsWith(`${scope}/`);
  });
}

/** Each expected item's answer item, every one distinct, or null when no such matching exists. */
function matchItems(
  expected: readonly ExpectedItem[],
  items: readonly TriageItem[],
): Map<string, TriageItem> | null {
  const assign = (i: number, used: Set<TriageItem>): Map<string, TriageItem> | null => {
    const want = expected[i];
    if (want === undefined) return new Map();
    for (const item of items) {
      if (used.has(item) || !want.covers.every((path) => covers(item, path))) continue;
      const rest = assign(i + 1, new Set([...used, item]));
      if (rest) return rest.set(want.name, item);
    }
    return null;
  };
  return assign(0, new Set());
}

function scoreTriage(c: TriageCase, run: TriageRun, text: string): Score {
  const parsed = json(text);
  if (!parsed) return score("unusable", "the answer is not JSON");
  const checked = checkTriageAnswer(run.outputSchema, parsed.value, run.map);
  if ("rejection" in checked) {
    return score(
      "unusable",
      `the runner rejects the answer: ${checked.rejection.code}`,
    );
  }
  const { items } = checked.answer;
  const expected = c.expected.items;
  if (items.length !== expected.length) {
    return score("wrong", `${items.length} items, and ${expected.length} is right`);
  }
  const matched = matchItems(expected, items);
  if (!matched) {
    return score(
      "wrong",
      "the items do not cover the expected items' paths one to one",
    );
  }
  for (const want of expected) {
    const item = matched.get(want.name) as TriageItem;
    const after = want.after
      .map((name) => (matched.get(name) as TriageItem).key)
      .sort();
    if ([...item.blockedBy].sort().join("\n") !== after.join("\n")) {
      return score(
        "wrong",
        `the ${want.name} item is not blocked by exactly the items it waits on`,
      );
    }
    if (item.needsDidi !== want.needsDidi || item.hold !== want.hold) {
      return score(
        "wrong",
        `the ${want.name} item's needsDidi or hold is not as expected`,
      );
    }
  }
  return score("correct", `${expected.length} items, covering and ordered as expected`);
}

/**
 * Whether the runner sends the item to Didi on this answer: the negation of
 * `council_decision_recorded` (src/core/guards/escalation.ts), which passes only for `resolve`
 * with both flags present and false. scoring.test.ts checks the two agree on every answer.
 */
export function goesToDidi(answer: EscalationAnswer): boolean {
  return (
    answer.outcome === COUNCIL_CANNOT_RESOLVE ||
    answer.changesProductDirection !== false ||
    answer.passesGate !== false
  );
}

const REASON_HOLDS: Record<DidiReason, (answer: EscalationAnswer) => boolean> = {
  cannot_resolve: (a) => a.outcome === COUNCIL_CANNOT_RESOLVE,
  changes_product_direction: (a) => a.changesProductDirection,
  passes_gate: (a) => a.passesGate,
};

function scoreCouncil(c: CouncilCase, run: CouncilRun, text: string): Score {
  const parsed = json(text);
  if (!parsed) return score("unusable", "the answer is not JSON");
  const problem = outputProblem(run.outputSchema, parsed.value);
  if (problem)
    return score("unusable", `the answer does not fit its schema: ${problem}`);
  const read = readEscalationAnswer(parsed.value);
  if ("problem" in read)
    return score("unusable", `the answer is unusable: ${read.problem}`);
  const toDidi = goesToDidi(read.answer);
  if (c.expected.route === "council") {
    return toDidi
      ? score("wrong", "the item goes to Didi, and the Council should resolve it")
      : score("correct", "the Council resolves it, as expected");
  }
  if (!toDidi)
    return score("wrong", "the Council resolves it, and it should go to Didi");
  const reasons = c.expected.reasons;
  if (!reasons.some((reason) => REASON_HOLDS[reason](read.answer))) {
    return score("wrong", `the item goes to Didi, but not for ${reasons.join(" or ")}`);
  }
  return score("correct", "the item goes to Didi, for a reason the case accepts");
}

/** Scores the run's final text against the case. The run must be the case's own. */
export function scoreAnswer(c: EvalCase, run: CaseRun, finalText: string): Score {
  if (run.caseId !== c.id || run.role !== c.role) {
    throw new Error("the run is not this case's run");
  }
  switch (c.role) {
    case "qa":
      return scoreQa(c, run as QaRun, finalText);
    case "triage":
      return scoreTriage(c, run as TriageRun, finalText);
    case "council":
      return scoreCouncil(c, run as CouncilRun, finalText);
  }
}
