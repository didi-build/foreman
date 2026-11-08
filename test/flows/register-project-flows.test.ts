// Seam: the called flow `f/foreman/register_project` (flow, D-345, D-346, D-348, O-109) on the
// memory store, through the flow layer's deps (`flowDepsFor`) with the fake settings file and the
// fake GitHub repository calls; and once with the runner's own GitHub parts, which refuse until
// the runner App exists. The rules themselves are in test/register-project.test.ts. Synthetic
// data only; nothing reaches GitHub or Windmill.
import { describe, expect, it } from "vitest";

import { run as registerProject } from "../../flows/register-project.ts";
import {
  runnerProjectRepositories,
  runnerProjectSettings,
} from "../../flows/lib/compose.ts";
import { REGISTER_REFUSALS } from "../../src/core/register-project.ts";
import { createFlowFixture } from "./flow-fixture.ts";

const INPUT = {
  slug: "garden-notes",
  description: "A small notes app for the garden club.",
};

describe("Didi's register-project flow (flow, D-345, O-109)", () => {
  it("creates the repository and records the project once, then answers already_registered once setup finished", async () => {
    const f = await createFlowFixture();
    await f.live();
    f.projectSettings.listed = ["rehearsal", INPUT.slug];
    const first = await registerProject(f.deps, INPUT);
    expect(first).toMatchObject({
      outcome: "registered",
      repository: "created",
      project: {
        slug: INPUT.slug,
        name: INPUT.slug,
        repo: "didi-build/garden-notes",
        privilegedPathsExtra: [],
        prodRequiresApproval: true,
        stagingUrl: "https://garden-notes.didi.build",
      },
    });
    expect(await f.store.getProjectBySlug(INPUT.slug)).toEqual(
      first.outcome === "registered" ? first.project : null,
    );
    f.bootstrap.finish(INPUT.slug, "success");
    expect(await registerProject(f.deps, INPUT)).toMatchObject({
      outcome: "already_registered",
    });
    expect(f.projectRepositories.generated).toEqual([
      { name: INPUT.slug, description: INPUT.description },
    ]);
  });

  it("writes and creates nothing under the kill switch or in dry run", async () => {
    const killed = await createFlowFixture();
    await killed.live();
    await killed.killed();
    killed.projectSettings.listed = [INPUT.slug];
    expect(await registerProject(killed.deps, INPUT)).toMatchObject({
      outcome: "refused",
      reason: "kill_switch",
    });
    // The fixture starts in dry run.
    const dry = await createFlowFixture();
    dry.projectSettings.listed = [INPUT.slug];
    expect(await registerProject(dry.deps, INPUT)).toMatchObject({
      outcome: "dry_run",
    });
    for (const f of [killed, dry]) {
      expect(f.projectRepositories.generated).toEqual([]);
      expect(await f.store.getProjectBySlug(INPUT.slug)).toBeNull();
    }
  });

  it("refuses on the settings read with the runner's own GitHub parts until the runner App exists", async () => {
    const f = await createFlowFixture();
    await f.live();
    const deps = {
      ...f.deps,
      projectSettings: runnerProjectSettings(),
      projectRepositories: runnerProjectRepositories(),
    };
    expect(await registerProject(deps, INPUT)).toEqual({
      outcome: "refused",
      reason: "settings_unreadable",
      message: REGISTER_REFUSALS.settings_unreadable,
    });
    expect(await f.store.getProjectBySlug(INPUT.slug)).toBeNull();
  });

  it("refuses on the creation token with the runner's own repository port, recording nothing", async () => {
    const f = await createFlowFixture();
    await f.live();
    f.projectSettings.listed = [INPUT.slug];
    const deps = { ...f.deps, projectRepositories: runnerProjectRepositories() };
    expect(await registerProject(deps, INPUT)).toEqual({
      outcome: "refused",
      reason: "creation_token_refused",
      message: REGISTER_REFUSALS.creation_token_refused,
    });
    expect(await f.store.getProjectBySlug(INPUT.slug)).toBeNull();
  });
});
