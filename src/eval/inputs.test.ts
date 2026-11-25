import { describe, expect, it } from "vitest";

import { taskFileJson } from "../adapters/agent-runtime/kubernetes/task.ts";
import { instructionsFor, readBotFiles } from "../adapters/contracts-file/bot-files.ts";
import { createWorkspace } from "../agent-images/claude-api/files.ts";
import { councilCast } from "../core/council-cast.ts";
import { fixture } from "../core/guards/testing.ts";
import { CONTEXT_NOTICE } from "../core/run-context.ts";
import { quoted } from "../core/task-input.ts";
import { NEEDS_DECISION_ESCALATION_REASON } from "../core/run-reports.ts";
import { loadCases, type CouncilCase, type QaCase, type TriageCase } from "./cases.ts";
import { caseChange } from "./change.ts";
import { buildCaseRun } from "./inputs.ts";

const bots = readBotFiles();
const cases = loadCases();
const of = <R extends "qa" | "triage" | "council">(role: R) =>
  cases.filter((c) => c.role === role) as (R extends "qa"
    ? QaCase
    : R extends "triage"
      ? TriageCase
      : CouncilCase)[];

/** The summary every case's input ends with, until cases carry records (ADR 0119 slice 3a). */
const EMPTY_SUMMARY = `# Context from this project\n\n${CONTEXT_NOTICE}\n\nNo records yet.`;

describe("weekly model test set inputs (unit: each case's run, built by the runner's builders, ADR 0117)", () => {
  it("builds every case's task file, and the runner's task file check accepts it", () => {
    for (const c of cases) {
      const run = buildCaseRun(c, bots, cases);
      expect(() => taskFileJson(c.role, run.task), c.id).not.toThrow();
      expect(run.taskType, c.id).toBe(c.taskType);
      // The instructions a real run of the case's task type gets, never a copy: QA's and
      // Triage's composed with their persona, the Council's with all four, Product as chair, for
      // its discussion (ADR 0119 slices 2 and 6e).
      expect(run.task.instructions, c.id).toBe(
        instructionsFor(bots[c.role], c.taskType),
      );
      const own =
        bots[c.role].taskInstructions?.[c.taskType] ?? bots[c.role].instructions;
      expect(run.task.instructions, c.id).toMatch(/^## What every agent shares\n\n/);
      expect(run.task.instructions.endsWith(own.trimEnd()), c.id).toBe(true);
      expect(run.task.instructions.includes("### Product, the chair"), c.id).toBe(
        c.role === "council",
      );
    }
  });

  it("gives QA the item, the pull request and head commit, its change, the evidence ids and the tree", async () => {
    for (const c of of("qa")) {
      const run = buildCaseRun(c, bots, cases);
      const { input } = run.task;
      expect(input, c.id).toContain(quoted(c.input.item.title));
      for (const criterion of c.input.item.acceptanceCriteria) {
        expect(input, c.id).toContain(`- ${criterion.replace(/\s*\n\s*/g, " ")}`);
      }
      expect(input, c.id).toContain(`## Pull request\n\n${c.input.pullRequest}`);
      expect(input, c.id).toContain(`## Head commit\n\n${c.input.headSha}`);
      // The pull request's change at the head, computed from the trees (D-431): every changed
      // file listed, and its diff in full, as a real run gets them from GitHub.
      expect(run.change, c.id).toEqual(caseChange(c, cases));
      expect(input, c.id).toContain("# The pull request's change");
      expect(input, c.id).toContain(`to head commit ${c.input.headSha}.`);
      for (const file of run.change.files) {
        expect(input, `${c.id}: ${file.path}`).toContain(
          `- \`${file.path}\` (${file.status}, +${file.additions} -${file.deletions})`,
        );
        expect(input, `${c.id}: ${file.path}`).toContain(
          `### \`${file.path}\`\n\n\`\`\`diff\n${file.patch ?? ""}\n\`\`\``,
        );
      }
      expect(input, c.id).not.toContain("not shown here");
      expect(input, c.id).not.toContain("is cut here");
      // The case format holds no project records yet: the summary says so (ADR 0119 slice 3a).
      expect(input.endsWith(`${EMPTY_SUMMARY}\n`), c.id).toBe(true);
      expect(run.task.nodeId, c.id).toBe(c.input.item.id);
      expect(run.evidenceIds, c.id).toEqual(c.input.evidence.map((e) => e.id));
      expect(run.task.outputSchema, c.id).toBeUndefined();
      // QA's own read-only tools read the case's tree, and only it.
      const workspace = createWorkspace(run.workspace, () => undefined);
      for (const path of c.input.changedFiles) {
        const read = await workspace.run("read_file", { path });
        expect(read.isError, `${c.id}: ${path}`).toBe(false);
      }
      expect((await workspace.run("read_file", { path: "../case.yaml" })).isError).toBe(
        true,
      );
    }
  });

  it("gives Triage the plan and the repo map built from the tree at the case's commit", () => {
    for (const c of of("triage")) {
      const run = buildCaseRun(c, bots, cases);
      expect(run.map.commitSha, c.id).toBe(c.input.commitSha);
      expect(
        run.map.files.map((f) => f.path),
        c.id,
      ).toEqual([...c.tree.files.keys()].sort());
      expect(run.map.scripts.check, c.id).toBeDefined();
      expect(run.task.input, c.id).toContain(quoted(c.input.plan));
      expect(run.task.input, c.id).toContain(`at commit ${c.input.commitSha}`);
      expect(run.task.input.endsWith(`${EMPTY_SUMMARY}\n`), c.id).toBe(true);
      expect(run.outputSchema, c.id).toEqual(bots.triage.outputSchemas?.answer);
      expect(run.task.outputSchema, c.id).toEqual(run.outputSchema);
    }
    const page = buildCaseRun(
      of("triage").find((c) => c.id === "triage-helper-then-page") as TriageCase,
      bots,
      cases,
    );
    expect(page.map.files.find((f) => f.path === "gallery/App.tsx")?.exports).toEqual([
      "App",
    ]);
  });

  it("gives the Council the escalated item and why, with the escalation schema", () => {
    for (const c of of("council")) {
      const run = buildCaseRun(c, bots, cases);
      expect(run.task.input, c.id).toContain("# Council question");
      expect(run.task.input, c.id).toContain(
        `## Escalated from\n\n${c.input.escalatedFrom}`,
      );
      for (const why of c.input.why)
        expect(run.task.input, c.id).toContain(quoted(why));
      expect(run.task.input, c.id).not.toContain("# Context from this project");
      expect(run.outputSchema, c.id).toEqual(bots.council.outputSchemas?.escalation);
    }
  });

  it("gives each Council case its discussion: Product as chair, the cast councilCast gives the escalated item, and the table's pull-in limit (ADR 0119 slice 6e)", () => {
    const table = bots.council.discussion;
    if (!table) throw new Error("the Council's bot file has no discussion table");
    for (const c of of("council")) {
      const run = buildCaseRun(c, bots, cases);
      const cast = councilCast(table, {
        kind: "escalation",
        node: { track: c.input.item.track },
      });
      const expected = { chair: "product", cast, maxPullIns: table.maxPullIns };
      expect(run.task.discussion, c.id).toEqual(expected);
      expect(run.discussion, c.id).toEqual(expected);
      // Both cases are code items: the Developer builds them, then Quality (D-463).
      expect(cast, c.id).toEqual(["developer", "quality"]);
    }
    // A design item's escalation gets the Designer, from the same table and the same function.
    const [first] = of("council");
    if (!first) throw new Error("no Council case");
    const design = {
      ...first,
      input: {
        ...first.input,
        item: { ...first.input.item, track: "design" as const },
      },
    };
    const run = buildCaseRun(design, bots, cases);
    expect(run.task.discussion?.cast).toEqual(["designer", "quality"]);
    expect(() => taskFileJson("council", run.task)).not.toThrow();
    // No other role's case is a discussion.
    for (const c of cases.filter((x) => x.role !== "council")) {
      expect(buildCaseRun(c, bots, cases).task, c.id).not.toHaveProperty("discussion");
    }
  });

  it("lists QA's and Triage's declared context tools as the runner does, and none for the Council (ADR 0119 slice 3d)", () => {
    for (const c of cases) {
      const task = buildCaseRun(c, bots, cases).task;
      if (c.role === "council") expect(task, c.id).not.toHaveProperty("contextTools");
      else
        expect(task.contextTools, c.id).toEqual([
          "search_decisions",
          "find_similar_items",
          "read_item_history",
        ]);
    }
    const tools = ["search_decisions", "find_similar_items"] as const;
    const declared = {
      ...bots,
      qa: { ...bots.qa, contextTools: [...tools] },
      triage: { ...bots.triage, contextTools: [...tools] },
    };
    for (const c of cases) {
      const run = buildCaseRun(c, declared, cases);
      expect(() => taskFileJson(c.role, run.task), c.id).not.toThrow();
      if (c.role === "council")
        expect(run.task, c.id).not.toHaveProperty("contextTools");
      else expect(run.task.contextTools, c.id).toEqual(tools);
    }
  });

  it("gives no case the browser, even when QA's bot file declares it: no case has a site (ADR 0119 slice 5c, a known gap)", () => {
    const declared = { ...bots, qa: { ...bots.qa, browser: true as const } };
    for (const c of cases) {
      expect(buildCaseRun(c, bots, cases).task, c.id).not.toHaveProperty("browser");
      expect(buildCaseRun(c, declared, cases).task, c.id).not.toHaveProperty("browser");
    }
  });

  it("records a builder's stop exactly as the runner does: its reason and the guard's detail", async () => {
    for (const c of of("council")) {
      const [reason, detail] = c.input.why;
      expect(reason, c.id).toBe(NEEDS_DECISION_ESCALATION_REASON);
      const words = (detail ?? "").replace(/^a bot asked: /, "");
      const f = await fixture({ state: "in_development" });
      await f.evidence("agent_report", null, { escalate: true, reason: words });
      const check = await f.check("escalation_trigger_met");
      expect(check.pass, c.id).toBe(true);
      expect(check.detail, c.id).toBe(detail);
    }
  });
});
