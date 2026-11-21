// Seam: unit, plain logic with a fake port. The daily check's list of applies made without
// approval (D-378, D-444, O-158, src/core/add-only-applies.ts): which add-only apply jobs it
// lists in the window, how each ended, the projects from the job's name, and what it says when
// GitHub's runs cannot be read. Then the lines the check shows, in the text and on the page, and
// the generator reading the port. Synthetic data only.
import { describe, expect, it } from "vitest";

import {
  ADD_ONLY_WORKFLOWS,
  projectsOfJobName,
  unreviewedApplies,
  type AddOnlyApplyJob,
} from "../src/core/add-only-applies.ts";
import { generateDailyCheck } from "../src/core/daily-check.ts";
import {
  ADD_ONLY_APPLIES_UNREADABLE,
  renderDailyCheck,
  renderDailyCheckHtml,
} from "../src/core/daily-check-render.ts";
import { createReconcileFixture, START } from "./reconcile-fixture.ts";

const TO = new Date("2026-11-21T11:00:00Z");
const FROM = new Date("2026-11-20T11:00:00Z");
const WINDOW = { from: FROM, to: TO };

const job = (extra: Partial<AddOnlyApplyJob> = {}): AddOnlyApplyJob => ({
  workflow: "platform",
  runNumber: 57,
  name: "kubectl-apply-add-only (garden-notes)",
  status: "completed",
  conclusion: "success",
  startedAt: new Date("2026-11-21T09:58:00Z"),
  completedAt: new Date("2026-11-21T10:04:00Z"),
  ...extra,
});
const port = (jobs: AddOnlyApplyJob[] | Error) => ({
  addOnlyApplies: {
    async jobsSince() {
      if (jobs instanceof Error) throw jobs;
      return jobs;
    },
  },
});

describe("the applies made without approval (unit, O-158)", () => {
  it("reads the projects from the job's name, and nothing from any other name", () => {
    expect(
      projectsOfJobName("platform", "kubectl-apply-add-only (garden-notes)"),
    ).toEqual(["garden-notes"]);
    expect(projectsOfJobName("infra", "tofu-apply-add-only (a,b-2,c)")).toEqual([
      "a",
      "b-2",
      "c",
    ]);
    for (const name of [
      "kubectl-apply-add-only",
      "kubectl-apply-add-only ()",
      "kubectl-apply-add-only (${{ needs.plan.outputs.add_only_projects }})",
      "kubectl-apply-add-only (a, b)",
      "kubectl-apply-add-only (a,b,c,d)",
      "kubectl-apply-add-only (Garden)",
      "tofu-apply-add-only (garden-notes)",
    ]) {
      expect(projectsOfJobName("platform", name), name).toBeNull();
    }
  });

  it("lists each apply that ended in the window, oldest first, with how it ended, and each still running", async () => {
    const report = await unreviewedApplies(
      port([
        job({ runNumber: 58, completedAt: new Date("2026-11-21T10:30:00Z") }),
        job({
          workflow: "infra",
          runNumber: 31,
          name: "tofu-apply-add-only (garden-notes)",
          conclusion: "failure",
          completedAt: new Date("2026-11-21T10:06:00Z"),
        }),
        job(),
        job({
          runNumber: 59,
          status: "in_progress",
          conclusion: null,
          completedAt: null,
        }),
        // Outside the window, skipped (it never ran), and not an add-only job.
        job({ runNumber: 40, completedAt: new Date("2026-11-20T10:59:00Z") }),
        job({ runNumber: 41, conclusion: "skipped" }),
        job({ runNumber: 42, name: "kubectl-apply" }),
      ]),
      WINDOW,
    );
    expect(report.unreadable).toBe(false);
    expect(report.applies).toEqual([
      {
        workflow: "platform",
        label: "Platform",
        runNumber: 59,
        projects: ["garden-notes"],
        outcome: "running",
        conclusion: null,
        at: new Date("2026-11-21T09:58:00Z"),
      },
      {
        workflow: "platform",
        label: "Platform",
        runNumber: 57,
        projects: ["garden-notes"],
        outcome: "applied",
        conclusion: null,
        at: new Date("2026-11-21T10:04:00Z"),
      },
      {
        workflow: "infra",
        label: "Infra apply",
        runNumber: 31,
        projects: ["garden-notes"],
        outcome: "did_not_finish",
        conclusion: "failure",
        at: new Date("2026-11-21T10:06:00Z"),
      },
      expect.objectContaining({ runNumber: 58, outcome: "applied" }),
    ]);
  });

  it("still lists an apply whose job name does not show its projects, and says so when GitHub cannot be read", async () => {
    const report = await unreviewedApplies(
      port([job({ name: "kubectl-apply-add-only" })]),
      WINDOW,
    );
    expect(report.applies[0]?.projects).toBeNull();
    expect(await unreviewedApplies(port(new Error("refused")), WINDOW)).toEqual({
      applies: [],
      unreadable: true,
    });
  });

  it("names the two environments and job names the workflows use", () => {
    expect(ADD_ONLY_WORKFLOWS.platform).toMatchObject({
      file: "platform.yml",
      job: "kubectl-apply-add-only",
      environment: "platform-add-project",
    });
    expect(ADD_ONLY_WORKFLOWS.infra).toMatchObject({
      file: "infra-apply.yml",
      job: "tofu-apply-add-only",
      environment: "infra-add-project",
    });
  });
});

describe("the daily check's lines for applies made without approval (unit, O-158)", () => {
  it("shows when, which workflow, which project and how it ended, before the projects, in the text and on the page", async () => {
    const f = await createReconcileFixture();
    const at = (minutesBefore: number) => new Date(START - minutesBefore * 60_000);
    const check = await generateDailyCheck(
      {
        ...f.deps,
        ...port([
          job({ completedAt: at(60), startedAt: at(66) }),
          job({
            workflow: "infra",
            runNumber: 31,
            name: "tofu-apply-add-only (garden-notes,seed-swap)",
            conclusion: "failure",
            completedAt: at(30),
          }),
          job({
            runNumber: 60,
            name: "kubectl-apply-add-only",
            status: "queued",
            conclusion: null,
            completedAt: null,
            startedAt: at(5),
          }),
        ]),
      },
      { holdReleaseRequestFlow: "f/foreman/hold_release_request" },
    );
    const when = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const lines = [
      `Applied without approval (D-378): the Platform workflow's add-only apply for garden-notes, ${when(at(60))}, run 57.`,
      `Did not finish (failure), so part of its plan may be applied without approval (D-378): the Infra apply workflow's add-only apply for garden-notes, seed-swap, ${when(at(30))}, run 31. Check its run.`,
      `Still running without approval (D-378): the Platform workflow's add-only apply for projects its job's name does not show, started ${when(at(5))}, run 60.`,
    ];
    const text = renderDailyCheck(check).split("\n");
    const first = text.indexOf(lines[0]!);
    expect(first).toBeGreaterThan(0);
    expect(text.slice(first, first + 3)).toEqual(lines);
    const html = renderDailyCheckHtml(check, { flowPages: {} });
    for (const line of lines) expect(html).toContain(line.replaceAll("'", "&#39;"));
  });

  it("says when the applies could not be read, and nothing when none ran or they were not read", async () => {
    const f = await createReconcileFixture();
    const options = { holdReleaseRequestFlow: "f/foreman/hold_release_request" };
    const unreadable = await generateDailyCheck(
      { ...f.deps, ...port(new Error("refused")) },
      options,
    );
    expect(renderDailyCheck(unreadable)).toContain(ADD_ONLY_APPLIES_UNREADABLE);
    for (const deps of [{ ...f.deps, ...port([]) }, f.deps]) {
      const check = await generateDailyCheck(deps, options);
      expect(renderDailyCheck(check)).not.toMatch(/without approval|add-only/);
    }
  });
});
