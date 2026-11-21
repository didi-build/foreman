// Seam: the called flow `f/foreman/new_project` (flow, ADR 0118 appendix C, D-434, D-443, O-161)
// on the memory store, through the flow layer's deps (`flowDepsFor`) with the fake deploy target,
// the fake settings, workflow starts, repositories, DNS lookup and Bootstrap; and once with the
// runner's own GitHub parts and no runner App key stored, so each token is refused before
// anything is sent. Also the retired `f/foreman/register_project`, which refuses with fixed text.
// The rules themselves are in test/new-project.test.ts. Synthetic data only; nothing reaches
// GitHub, Cloudflare or Windmill.
import { describe, expect, it } from "vitest";

import { run as newProject } from "../../flows/new-project.ts";
import {
  main as registerProject,
  REGISTER_PROJECT_RETIRED,
} from "../../flows/register-project.ts";
import {
  runnerProjectRepositories,
  runnerProjectSettings,
  runnerProjectWorkflows,
} from "../../flows/lib/compose.ts";
import { windmillJobId } from "../../flows/lib/windmill.ts";
import { NEW_PROJECT_REFUSALS } from "../../src/core/new-project.ts";
import { appTokensWithoutKeys, createFlowFixture } from "./flow-fixture.ts";

const INPUT = {
  slug: "garden-notes",
  displayName: "Garden Notes",
  purpose: "A small notes app for the garden club.",
  collectsPersonalData: true,
};

describe("Didi's New project flow (flow, ADR 0118 appendix C, O-161)", () => {
  it("sets the project up in order, then answers completed and makes nothing twice", async () => {
    const f = await createFlowFixture();
    await f.live();
    const first = await newProject(f.deps, INPUT);
    expect(first.outcome).toBe("created");
    expect(first.steps.map((l) => l.outcome)).toEqual([
      "created",
      "created",
      "created",
      "started",
      "created",
      "created",
      "started",
    ]);
    expect(f.stagingTarget.setUps).toEqual([
      { slug: INPUT.slug, displayName: INPUT.displayName, purpose: INPUT.purpose },
    ]);
    expect([...f.projectSettings.files.keys()]).toEqual([INPUT.slug]);
    expect(f.projectWorkflows.starts).toEqual([
      f.projectSettings.files.get(INPUT.slug)?.commit,
    ]);
    expect(f.projectRepositories.generated).toEqual([
      { name: INPUT.slug, description: INPUT.purpose },
    ]);
    expect(await f.store.getProjectBySlug(INPUT.slug)).toMatchObject({
      name: "Garden Notes",
      repo: "didi-build/garden-notes",
      deployTarget: "cloudflare",
      prodRequiresApproval: true,
      stagingUrl: "https://garden-notes.didi.build",
    });
    expect(f.bootstrap.restartInputs).toEqual([
      { displayName: "Garden Notes", collectsPersonalData: true },
    ]);
    f.bootstrap.finish(INPUT.slug, "success");
    const again = await newProject(f.deps, INPUT);
    expect(again.outcome).toBe("completed");
    expect(f.projectSettings.creates).toHaveLength(1);
    expect(f.projectRepositories.generated).toHaveLength(1);
    expect(f.bootstrap.calls.filter((c) => c.startsWith("restart"))).toHaveLength(1);
  });

  it("creates, writes and starts nothing under the kill switch or in dry run", async () => {
    const killed = await createFlowFixture();
    await killed.live();
    await killed.killed();
    expect(await newProject(killed.deps, INPUT)).toMatchObject({
      outcome: "refused",
      reason: "kill_switch",
    });
    // The fixture starts in dry run.
    const dry = await createFlowFixture();
    expect(await newProject(dry.deps, INPUT)).toMatchObject({ outcome: "dry_run" });
    expect(dry.stagingTarget.setUps).toEqual([
      {
        slug: INPUT.slug,
        displayName: INPUT.displayName,
        purpose: INPUT.purpose,
        dryRun: true,
      },
    ]);
    for (const f of [killed, dry]) {
      expect(f.projectSettings.creates).toEqual([]);
      expect(f.projectWorkflows.starts).toEqual([]);
      expect(f.projectRepositories.generated).toEqual([]);
      expect(f.bootstrap.calls).toEqual([]);
      expect(await f.store.getProjectBySlug(INPUT.slug)).toBeNull();
    }
  });

  it("refuses on the standard size's read with the runner's own GitHub parts and no runner App key, sending nothing", async () => {
    const f = await createFlowFixture();
    await f.live();
    const apps = appTokensWithoutKeys();
    const deps = {
      ...f.deps,
      projectSettings: runnerProjectSettings(apps.runner, apps.settingsWrite),
      projectWorkflows: runnerProjectWorkflows(apps.workflowStart),
      projectRepositories: runnerProjectRepositories(
        apps.repositoryCreation,
        apps.runner,
      ),
    };
    expect(await newProject(deps, INPUT)).toMatchObject({
      outcome: "refused",
      reason: "standard_quota_unreadable",
      message: NEW_PROJECT_REFUSALS.standard_quota_unreadable,
    });
    expect(f.stagingTarget.setUps).toEqual([]);
    expect(await f.store.getProjectBySlug(INPUT.slug)).toBeNull();
    expect(apps.sent).toEqual([]);
  });

  it("stops at the settings write's token with the runner's own write port and no key, after the setup only", async () => {
    const f = await createFlowFixture();
    await f.live();
    const apps = appTokensWithoutKeys();
    const real = runnerProjectSettings(apps.runner, apps.settingsWrite);
    const deps = {
      ...f.deps,
      projectSettings: {
        standardQuota: () => f.projectSettings.standardQuota(),
        readFile: (slug: string) => f.projectSettings.readFile(slug),
        createFile: real.createFile,
      },
      projectWorkflows: runnerProjectWorkflows(apps.workflowStart),
    };
    const result = await newProject(deps, INPUT);
    expect(result).toMatchObject({
      outcome: "refused",
      reason: "settings_token_refused",
    });
    expect(result.steps.map((l) => l.outcome)).toEqual([
      "created",
      "created",
      "refused",
      "not_reached",
      "not_reached",
      "not_reached",
      "not_reached",
    ]);
    expect(f.projectRepositories.generated).toEqual([]);
    expect(apps.sent).toEqual([]);
    // With a file in place, the starts' token is refused the same way, starting nothing.
    expect(await deps.projectWorkflows.start("a".repeat(40))).toEqual({
      platform: { kind: "refused", step: "token" },
      infra: { kind: "refused", step: "token" },
    });
    expect(apps.sent).toEqual([]);
  });

  it("names its Windmill run only when Windmill gives a UUID", () => {
    const id = "0192f0a0-1234-4abc-8def-0123456789ab";
    expect(windmillJobId({ WM_JOB_ID: id })).toBe(id);
    for (const value of [undefined, "", "1234", `${id}\n`, id.toUpperCase()])
      expect(windmillJobId({ WM_JOB_ID: value })).toBeNull();
  });
});

describe("the retired register-project form (flow, O-161)", () => {
  it("refuses with fixed text naming the New project form, taking no box and reading nothing", async () => {
    expect(await registerProject()).toEqual(REGISTER_PROJECT_RETIRED);
    expect(REGISTER_PROJECT_RETIRED).toEqual({
      outcome: "refused",
      reason: "retired",
      message: expect.stringContaining("f/foreman/new_project") as string,
    });
    expect(registerProject.length).toBe(0);
  });
});
