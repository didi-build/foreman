// Seam: the flows of BOOTSTRAP_TOKEN's access only during a repository's own setup (flow, D-358
// lock (2), O-114) on the memory store, through the flow layer's deps (`flowDepsFor`) with the
// fake of the secret's list and Bootstrap's runs: the register form's grant and restart, the
// called flow `f/foreman/remove_bootstrap_access` once Bootstrap's restarted run ends, the
// reconcile flow's backstop in live mode, in dry run and under the kill switch, and the daily
// check's failed setup. Once more with the runner's own GitHub parts, which refuse until the runner
// App exists. The rules themselves are in test/bootstrap-access.test.ts and
// test/register-project.test.ts. Synthetic data only; nothing reaches GitHub or Windmill.
import { describe, expect, it } from "vitest";

import { run as dailyCheck } from "../../flows/daily-check.ts";
import { run as reconcile } from "../../flows/reconcile.ts";
import { run as registerProject } from "../../flows/register-project.ts";
import { run as removeAccess } from "../../flows/remove-bootstrap-access.ts";
import { runnerBootstrapAccess, runnerBootstrapRuns } from "../../flows/lib/compose.ts";
import {
  ACCESS_LIST_UNREADABLE,
  REMOVAL_TEXTS,
  SETUP_WINDOW_MINUTES,
} from "../../src/core/bootstrap-access.ts";
import { REGISTER_REFUSALS } from "../../src/core/register-project.ts";
import { createFlowFixture } from "./flow-fixture.ts";

const INPUT = {
  slug: "garden-notes",
  description: "A small notes app for the garden club.",
};
const REPO = "didi-build/garden-notes";

async function registered() {
  const f = await createFlowFixture();
  await f.live();
  f.projectSettings.listed = [INPUT.slug];
  expect(await registerProject(f.deps, INPUT)).toMatchObject({
    outcome: "registered",
    setup: "started",
  });
  return f;
}

describe("BOOTSTRAP_TOKEN's access in the flows (flow, D-358, O-114)", () => {
  it("the form grants, then restarts; the removal flow removes the access once the run ends", async () => {
    const f = await registered();
    expect(f.bootstrap.calls).toEqual([`grant ${INPUT.slug}`, `restart ${INPUT.slug}`]);
    expect([...f.bootstrap.selected]).toEqual([INPUT.slug]);
    f.bootstrap.finish(INPUT.slug, "failure");
    expect(await removeAccess(f.deps, { repo: REPO })).toEqual({
      outcome: "removed",
      repository: REPO,
    });
    expect(f.bootstrap.selected.size).toBe(0);
    // Run again after the failure, the form picks up where it stopped.
    expect(await registerProject(f.deps, INPUT)).toEqual({
      outcome: "setup_restarted",
      slug: INPUT.slug,
      repo: REPO,
    });
    expect([...f.bootstrap.selected]).toEqual([INPUT.slug]);
  });

  it("the reconcile flow's backstop keeps the new project inside its hour and removes every other repository", async () => {
    const f = await registered();
    f.bootstrap.selected.add("foreman");
    f.bootstrap.selected.add("launchpad");
    const first = await reconcile(f.deps);
    expect(first.bootstrapAccess).toEqual({
      mode: "live",
      kept: [REPO],
      removals: [
        { repository: "didi-build/foreman", cause: "not_a_project", result: "removed" },
        {
          repository: "didi-build/launchpad",
          cause: "not_a_project",
          result: "removed",
        },
      ],
      problem: null,
    });
    expect(first.problems).toEqual([]);
    f.advanceMinutes(SETUP_WINDOW_MINUTES);
    expect((await reconcile(f.deps)).bootstrapAccess?.removals).toEqual([
      { repository: REPO, cause: "window_passed", result: "removed" },
    ]);
    expect(f.bootstrap.selected.size).toBe(0);
  });

  it("in dry run the backstop and the removal flow only report", async () => {
    const f = await createFlowFixture();
    f.bootstrap.selected.add("foreman");
    expect((await reconcile(f.deps)).bootstrapAccess).toEqual({
      mode: "dry_run",
      kept: [],
      removals: [
        {
          repository: "didi-build/foreman",
          cause: "not_a_project",
          result: "would_remove",
        },
      ],
      problem: null,
    });
    expect(await removeAccess(f.deps, { repo: "didi-build/foreman" })).toMatchObject({
      outcome: "dry_run",
    });
    expect([...f.bootstrap.selected]).toEqual(["foreman"]);
  });

  it("under the kill switch neither the backstop nor the removal flow reads or removes anything", async () => {
    const f = await createFlowFixture();
    await f.live();
    await f.killed();
    f.bootstrap.selected.add("foreman");
    const result = await reconcile(f.deps);
    expect(result.stopped).toBe("kill_switch");
    expect(result.bootstrapAccess).toBeNull();
    expect(await removeAccess(f.deps, { repo: "didi-build/foreman" })).toEqual({
      outcome: "refused",
      reason: "kill_switch",
      message: REMOVAL_TEXTS.kill_switch,
    });
    expect(f.bootstrap.calls).toEqual([]);
    expect([...f.bootstrap.selected]).toEqual(["foreman"]);
  });

  it("the daily check says Bootstrap failed for the project and to run the form again", async () => {
    const f = await registered();
    f.bootstrap.finish(INPUT.slug, "failure");
    const [{ html }, { json }] = (await dailyCheck(f.deps)).render_all;
    expect(json.check.projectSetup).toEqual({
      failed: [
        {
          slug: INPUT.slug,
          message: "Bootstrap failed for garden-notes; run the register form again",
        },
      ],
      unreadable: [],
    });
    expect(json.text).toContain(
      "Bootstrap failed for garden-notes; run the register form again.",
    );
    expect(html).toContain(
      "Bootstrap failed for garden-notes; run the register form again.",
    );
    // Once the form's next restart succeeds, the check no longer says so.
    await registerProject(f.deps, INPUT);
    f.bootstrap.finish(INPUT.slug, "success");
    const after = (await dailyCheck(f.deps)).render_all[1].json;
    expect(after.check.projectSetup?.failed).toEqual([]);
    expect(after.text).not.toContain("Bootstrap failed");
  });

  it("with the runner's own GitHub parts, the form stops at the grant's token with the project recorded, and nothing else acts", async () => {
    const f = await createFlowFixture();
    await f.live();
    f.projectSettings.listed = [INPUT.slug];
    const deps = {
      ...f.deps,
      bootstrapAccess: runnerBootstrapAccess(),
      bootstrapRuns: runnerBootstrapRuns(),
    };
    expect(await registerProject(deps, INPUT)).toEqual({
      outcome: "refused",
      reason: "grant_token_refused",
      message: REGISTER_REFUSALS.grant_token_refused,
    });
    expect(await f.store.getProjectBySlug(INPUT.slug)).not.toBeNull();
    // Run again, it cannot read Bootstrap's runs either, and grants nothing.
    expect(await registerProject(deps, INPUT)).toMatchObject({
      reason: "setup_unreadable",
    });
    expect(await removeAccess(deps, { repo: REPO })).toEqual({
      outcome: "refused",
      reason: "token",
      message: REMOVAL_TEXTS.token,
    });
    const pass = await reconcile(deps);
    expect(pass.bootstrapAccess?.problem).toBe(ACCESS_LIST_UNREADABLE);
    expect(pass.problems).toContain(ACCESS_LIST_UNREADABLE);
    const check = (await dailyCheck(deps)).render_all[1].json;
    // The fixture's rehearsal project too: neither one's runs can be read yet.
    expect(check.check.projectSetup?.unreadable).toEqual([INPUT.slug, "rehearsal"]);
  });
});
