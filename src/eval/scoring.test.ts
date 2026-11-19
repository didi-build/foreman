import { describe, expect, it } from "vitest";

import { readBotFiles } from "../adapters/contracts-file/bot-files.ts";
import { parseVerdict } from "../agent-images/claude-api/verdict.ts";
import { readEscalationAnswer } from "../core/council.ts";
import { fixture } from "../core/guards/testing.ts";
import { outputProblem } from "../core/output-schema.ts";
import { checkTriageAnswer } from "../core/triage.ts";
import { loadCases, type EvalCase } from "./cases.ts";
import { buildCaseRun, type CouncilRun, type QaRun, type TriageRun } from "./inputs.ts";
import { goesToDidi, scoreAnswer, type ScoreOutcome } from "./scoring.ts";

const bots = readBotFiles();
const cases = loadCases();
const caseOf = (id: string): EvalCase => {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};
const runOf = (id: string) => buildCaseRun(caseOf(id), bots, cases);
const outcome = (id: string, answer: unknown): ScoreOutcome =>
  scoreAnswer(caseOf(id), runOf(id), JSON.stringify(answer)).outcome;
const example = (id: string) =>
  structuredClone(caseOf(id).example) as Record<string, unknown>;

describe("weekly model test set scoring (unit: answers checked by the runner's own checks, ADR 0117)", () => {
  it("passes every case's example answer through the runner's check for its role, and scores it correct", () => {
    for (const c of cases) {
      const run = buildCaseRun(c, bots, cases);
      const text = JSON.stringify(c.example);
      if (run.role === "qa") {
        expect("verdict" in parseVerdict(text, (run as QaRun).evidenceIds), c.id).toBe(
          true,
        );
      } else if (run.role === "triage") {
        const t = run as TriageRun;
        expect(
          "answer" in checkTriageAnswer(t.outputSchema, c.example, t.map),
          c.id,
        ).toBe(true);
      } else {
        expect(
          outputProblem((run as CouncilRun).outputSchema, c.example),
          c.id,
        ).toBeNull();
        expect("answer" in readEscalationAnswer(c.example), c.id).toBe(true);
      }
      expect(scoreAnswer(c, run, text), c.id).toEqual({
        outcome: "correct",
        detail: expect.any(String),
      });
    }
  });

  it("refuses to score a run against another case", () => {
    expect(() =>
      scoreAnswer(caseOf("qa-slugify-pass"), runOf("qa-truncate-pass"), "{}"),
    ).toThrow("not this case's run");
  });

  describe("QA", () => {
    const evidence = (id: string) => (runOf(id) as QaRun).evidenceIds.slice(0, 1);
    const pass = (id: string) => ({
      verdict: "pass",
      findings: [],
      evidenceIds: evidence(id),
    });
    const finding = (path: string, startLine = 1, endLine = 1) => ({
      path,
      startLine,
      endLine,
      note: "A problem.",
    });

    it("a fail on a correct pull request is wrong", () => {
      expect(
        outcome("qa-truncate-pass", {
          verdict: "fail",
          findings: [finding("src/truncate.ts")],
          evidenceIds: [],
        }),
      ).toBe("wrong");
    });

    it("a pass on each planted defect is wrong", () => {
      for (const id of [
        "qa-truncate-off-by-one",
        "qa-slugify-skipped-test",
        "qa-format-duration-fake-key",
        "qa-truncate-readme-change",
      ]) {
        expect(outcome(id, pass(id)), id).toBe("wrong");
      }
    });

    it("a fail counts only with a finding on a file the case accepts", () => {
      const fail = (path: string) => ({
        verdict: "fail",
        findings: [finding(path)],
        evidenceIds: [],
      });
      expect(outcome("qa-truncate-off-by-one", fail("src/truncate.ts"))).toBe(
        "correct",
      );
      expect(outcome("qa-truncate-off-by-one", fail("test/truncate.test.ts"))).toBe(
        "correct",
      );
      expect(outcome("qa-truncate-off-by-one", fail("README.md"))).toBe("wrong");
      expect(outcome("qa-slugify-skipped-test", fail("src/slugify.ts"))).toBe("wrong");
      expect(outcome("qa-truncate-readme-change", fail("src/truncate.ts"))).toBe(
        "wrong",
      );
    });

    it("a verdict the runner would refuse is unusable", () => {
      const id = "qa-truncate-off-by-one";
      const run = runOf(id);
      const unusable = (text: string) => scoreAnswer(caseOf(id), run, text).outcome;
      expect(unusable("not json")).toBe("unusable");
      // A pass must cite the runner's evidence, and only evidence it supplied.
      expect(
        unusable(JSON.stringify({ verdict: "pass", findings: [], evidenceIds: [] })),
      ).toBe("unusable");
      expect(
        unusable(
          JSON.stringify({
            verdict: "pass",
            findings: [],
            evidenceIds: ["00000000-0000-4000-8000-000000000000"],
          }),
        ),
      ).toBe("unusable");
      // ADR 0112: every citation names a file and lines at the head commit.
      expect(
        unusable(
          JSON.stringify({
            verdict: "fail",
            findings: [finding("src/missing.ts")],
            evidenceIds: [],
          }),
        ),
      ).toBe("unusable");
      expect(
        unusable(
          JSON.stringify({
            verdict: "fail",
            findings: [finding("src/truncate.ts", 20, 400)],
            evidenceIds: [],
          }),
        ),
      ).toBe("unusable");
    });
  });

  describe("Triage", () => {
    const answer = (id: string) => example(id) as { items: Record<string, unknown>[] };

    it("the rehearsal's split of the truncate plan into a helper item and a tests item is wrong", () => {
      const split = answer("triage-truncate-plan");
      const [helper] = split.items as [Record<string, unknown>];
      split.items = [
        { ...helper, key: "helper", pathsInScope: ["src/truncate.ts"] },
        {
          ...helper,
          key: "tests",
          title: "Add unit tests for truncate",
          pathsInScope: ["test/truncate.test.ts"],
          blockedBy: ["helper"],
        },
      ];
      expect(outcome("triage-truncate-plan", split)).toBe("wrong");
    });

    it("one item for the two-part plan, or the parts in the wrong order, is wrong", () => {
      const id = "triage-helper-then-page";
      const one = answer(id);
      const [helper, page] = one.items as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      one.items = [
        {
          ...helper,
          pathsInScope: [
            "src/format-prop-value.ts",
            "test/format-prop-value.test.ts",
            "gallery/App.tsx",
          ],
        },
      ];
      expect(outcome(id, one)).toBe("wrong");

      const reversed = answer(id);
      reversed.items = [
        { ...helper, blockedBy: ["gallery-uses-helper"] },
        { ...page, blockedBy: [] },
      ];
      expect(outcome(id, reversed)).toBe("wrong");

      const unordered = answer(id);
      unordered.items = [helper, { ...page, blockedBy: [] }];
      expect(outcome(id, unordered)).toBe("wrong");

      const held = answer(id);
      held.items = [helper, { ...page, hold: true }];
      expect(outcome(id, held)).toBe("wrong");
    });

    it("an item that covers a folder holding the expected paths counts", () => {
      const id = "triage-helper-then-page";
      const folders = answer(id);
      const [helper, page] = folders.items as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      folders.items = [
        { ...helper, pathsInScope: ["src/format-prop-value.ts", "test/"] },
        { ...page, pathsInScope: ["gallery"] },
      ];
      expect(outcome(id, folders)).toBe("correct");
    });

    it("an answer the runner rejects is unusable", () => {
      const bad = answer("triage-slugify-plan");
      bad.items = [{ ...(bad.items[0] as object), pathsInScope: ["lib/slugify.ts"] }];
      expect(
        scoreAnswer(
          caseOf("triage-slugify-plan"),
          runOf("triage-slugify-plan"),
          JSON.stringify(bad),
        ),
      ).toEqual({
        outcome: "unusable",
        detail: "the runner rejects the answer: path_not_in_repo_map",
      });
      const extra = answer("triage-slugify-plan");
      extra.items = [{ ...(extra.items[0] as object), checks: ["npm run deploy"] }];
      expect(outcome("triage-slugify-plan", extra)).toBe("unusable");
    });
  });

  describe("the Council", () => {
    const answer = (
      outcome: "resolve" | "cannot_resolve",
      changesProductDirection: boolean,
      passesGate: boolean,
    ) => ({ outcome, note: "A decision.", changesProductDirection, passesGate });
    const combos = (["resolve", "cannot_resolve"] as const).flatMap((o) =>
      [false, true].flatMap((d) => [false, true].map((g) => answer(o, d, g))),
    );

    it("sends an answer to Didi exactly when the runner's council_decision_recorded guard does", async () => {
      for (const a of combos) {
        const f = await fixture({ state: "escalated_to_council" });
        await f.enterState("escalated_to_council");
        await f.decision("council_decision", "council", {
          outcome: a.outcome,
          changesProductDirection: a.changesProductDirection,
          passesGate: a.passesGate,
        });
        const guard = await f.check("council_decision_recorded");
        expect(goesToDidi(a), JSON.stringify(a)).toBe(!guard.pass);
      }
    });

    it("the answer-in-plan case is correct only when the Council resolves it", () => {
      for (const a of combos) {
        const resolves =
          a.outcome === "resolve" && !a.changesProductDirection && !a.passesGate;
        expect(outcome("council-answer-in-plan", a), JSON.stringify(a)).toBe(
          resolves ? "correct" : "wrong",
        );
      }
    });

    it("the product decision case is correct when it goes to Didi for the product question, not for a gate", () => {
      const id = "council-product-decision";
      expect(outcome(id, answer("resolve", false, false))).toBe("wrong");
      expect(outcome(id, answer("resolve", false, true))).toBe("wrong");
      expect(outcome(id, answer("resolve", true, false))).toBe("correct");
      expect(outcome(id, answer("cannot_resolve", false, false))).toBe("correct");
      expect(outcome(id, answer("cannot_resolve", true, true))).toBe("correct");
    });

    it("an answer outside the escalation schema is unusable", () => {
      const id = "council-answer-in-plan";
      expect(outcome(id, { ...answer("resolve", false, false), confidence: 1 })).toBe(
        "unusable",
      );
      expect(outcome(id, { ...answer("resolve", false, false), note: " " })).toBe(
        "unusable",
      );
      expect(outcome(id, { outcome: "resolve", note: "x" })).toBe("unusable");
    });
  });
});
