// Seam: unit, BOOTSTRAP_TOKEN's access only during a repository's own setup in the core (D-358
// lock (2), O-114), on the memory store with a clock the test moves and the fake of the secret's
// list and Bootstrap's runs (src/adapters/github/bootstrap-fake.ts). What "finished" means, the
// removal once Bootstrap's restarted run ends (on success and on failure), the reconcile pass's
// backstop (a repository inside its window kept, every other one removed), dry run, the kill
// switch, and the daily check's failed setups. The form's grant and restart are in
// test/register-project.test.ts. Synthetic data only; no real repository, token or GitHub call.
import { describe, expect, it } from "vitest";

import { createFakeBootstrap } from "../src/adapters/github/bootstrap-fake.ts";
import {
  ACCESS_LIST_UNREADABLE,
  bootstrapAccessPass,
  failedSetups,
  isBootstrapWorkflowPath,
  organizationRepositoryName,
  REMOVAL_TEXTS,
  removeAfterBootstrap,
  SETUP_WINDOW_MINUTES,
  setupStateOf,
  startSetup,
} from "../src/core/bootstrap-access.ts";
import { createMemoryStore } from "../src/core/memory-store.ts";
import { PROJECT_OWNER, plannedProject } from "../src/core/register-project.ts";
import type { Json } from "../src/core/store.ts";

const T0 = new Date("2026-11-07T12:00:00Z");
const MINUTE = 60_000;

async function setup(options: { live?: boolean } = {}) {
  const store = createMemoryStore();
  let now = T0.getTime();
  const clock = { now: () => new Date(now) };
  const setting = (key: string, value: Json) =>
    store.setSetting({ key, value, updatedBy: "test", updatedAt: T0 });
  await setting("kill_switch", false);
  await setting("dry_run", !(options.live ?? true));
  const bootstrap = createFakeBootstrap();
  let n = 0;
  /** A project registered `minutesAgo` before now, as the form records it. */
  const project = (slug: string, minutesAgo = 0) =>
    store.insertProject({
      ...plannedProject(slug),
      id: `75000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      createdAt: new Date(now - minutesAgo * MINUTE),
    });
  const deps = {
    store,
    clock,
    bootstrapAccess: bootstrap,
    bootstrapRuns: bootstrap,
  };
  return {
    store,
    setting,
    bootstrap,
    project,
    deps,
    pass: () => bootstrapAccessPass(deps),
    later: (minutes: number) => {
      now += minutes * MINUTE;
    },
  };
}

describe("what a finished setup is (unit, O-114)", () => {
  it("reads the newest restarted run: none, still going, success, or any other conclusion", () => {
    const run = (status: string, conclusion: string | null) => ({
      event: "workflow_dispatch",
      status,
      conclusion,
    });
    expect(setupStateOf(null)).toBe("not_started");
    expect(setupStateOf(run("queued", null))).toBe("running");
    expect(setupStateOf(run("in_progress", null))).toBe("running");
    expect(setupStateOf(run("completed", "success"))).toBe("succeeded");
    for (const conclusion of ["failure", "cancelled", "timed_out", "neutral", null])
      expect(setupStateOf(run("completed", conclusion)), String(conclusion)).toBe(
        "failed",
      );
  });

  it("knows Bootstrap's workflow path, with or without GitHub's @ref", () => {
    expect(isBootstrapWorkflowPath(".github/workflows/bootstrap.yml")).toBe(true);
    expect(isBootstrapWorkflowPath(".github/workflows/bootstrap.yml@main")).toBe(true);
    for (const path of [
      ".github/workflows/bootstrap.yaml",
      ".github/workflows/ci.yml",
      "x/.github/workflows/bootstrap.yml",
      ".github/workflows/bootstrap.ymlx",
      undefined,
    ])
      expect(isBootstrapWorkflowPath(path), String(path)).toBe(false);
  });

  it("takes only a repository of didi-build, the projects' own organization", () => {
    expect(PROJECT_OWNER).toBe("didi-build");
    expect(organizationRepositoryName("didi-build/garden-notes")).toBe("garden-notes");
    for (const repo of [
      "someone-else/garden-notes",
      "didi-build/",
      "didi-build/..",
      "didi-build/a/b",
      "didi-build/a b",
      "garden-notes",
      42,
    ])
      expect(organizationRepositoryName(repo), String(repo)).toBeNull();
  });

  it("starts setup with the grant first, then the restart", async () => {
    const f = await setup();
    expect(await startSetup(f.deps, "garden-notes")).toEqual({ started: true });
    expect(f.bootstrap.calls).toEqual(["grant garden-notes", "restart garden-notes"]);
  });
});

describe("removing the access once Bootstrap's restarted run ends (unit, O-114)", () => {
  it("removes the repository whatever the run's conclusion, without reading the run", async () => {
    for (const conclusion of ["success", "failure"]) {
      const f = await setup();
      await startSetup(f.deps, "garden-notes");
      f.bootstrap.finish("garden-notes", conclusion);
      f.bootstrap.calls = [];
      expect(await removeAfterBootstrap(f.deps, "didi-build/garden-notes")).toEqual({
        outcome: "removed",
        repository: "didi-build/garden-notes",
      });
      expect(f.bootstrap.calls).toEqual(["remove garden-notes"]);
      expect(f.bootstrap.selected.size).toBe(0);
    }
  });

  it("refuses a repository outside didi-build before reading anything", async () => {
    const f = await setup();
    for (const repo of ["someone-else/garden-notes", "garden-notes", "", null]) {
      expect(await removeAfterBootstrap(f.deps, repo), String(repo)).toEqual({
        outcome: "refused",
        reason: "not_a_repository",
        message: REMOVAL_TEXTS.not_a_repository,
      });
    }
    expect(f.bootstrap.calls).toEqual([]);
  });

  it("does nothing under the kill switch, and only reports in dry run", async () => {
    const killed = await setup();
    await killed.setting("kill_switch", true);
    killed.bootstrap.selected.add("garden-notes");
    expect(await removeAfterBootstrap(killed.deps, "didi-build/garden-notes")).toEqual({
      outcome: "refused",
      reason: "kill_switch",
      message: REMOVAL_TEXTS.kill_switch,
    });
    for (const dryRun of [true, "unset"] as const) {
      const dry = await setup();
      await dry.setting("dry_run", dryRun);
      dry.bootstrap.selected.add("garden-notes");
      expect(await removeAfterBootstrap(dry.deps, "didi-build/garden-notes")).toEqual({
        outcome: "dry_run",
        reason: "dry_run",
        message: REMOVAL_TEXTS.dry_run,
      });
      expect(dry.bootstrap.calls).toEqual([]);
      expect([...dry.bootstrap.selected]).toEqual(["garden-notes"]);
    }
    expect(killed.bootstrap.calls).toEqual([]);
  });

  it("names the step a refused removal stopped at, once, and never quotes the input", async () => {
    for (const step of ["token", "not_selected", "call"] as const) {
      const f = await setup();
      f.bootstrap.refuse.remove = step;
      const result = await removeAfterBootstrap(f.deps, "didi-build/garden-notes");
      expect(result, step).toEqual({
        outcome: "refused",
        reason: step,
        message: REMOVAL_TEXTS[step],
      });
      expect(JSON.stringify(result)).not.toContain("garden");
      expect(f.bootstrap.calls).toEqual(["remove garden-notes"]);
    }
    const f = await setup();
    const throwing = {
      ...f.bootstrap,
      remove: async () => {
        throw new Error("the connection dropped");
      },
    };
    expect(
      await removeAfterBootstrap(
        { store: f.store, bootstrapAccess: throwing },
        "didi-build/garden-notes",
      ),
    ).toMatchObject({ outcome: "refused", reason: "call" });
  });
});

describe("the reconcile pass's backstop (unit, D-358, O-114)", () => {
  it("keeps a project registered less than an hour ago whose setup has not finished, and removes everything else", async () => {
    const f = await setup();
    await f.project("new-one", 10); // not started yet
    await f.project("running-one", 59); // its restart is still going
    await f.project("old-one", SETUP_WINDOW_MINUTES); // registered an hour ago
    await f.project("done-one", 5); // its restart ended well
    await f.project("failed-one", 5); // its restart failed
    await f.bootstrap.restart("running-one");
    await f.bootstrap.restart("done-one");
    f.bootstrap.finish("done-one", "success");
    await f.bootstrap.restart("failed-one");
    f.bootstrap.finish("failed-one", "failure");
    for (const name of [
      "new-one",
      "running-one",
      "old-one",
      "done-one",
      "failed-one",
      "foreman",
      "launchpad",
    ])
      f.bootstrap.selected.add(name);
    f.bootstrap.calls = [];

    const pass = await f.pass();
    expect(pass).toEqual({
      mode: "live",
      kept: ["didi-build/new-one", "didi-build/running-one"],
      removals: [
        {
          repository: "didi-build/done-one",
          cause: "setup_finished",
          result: "removed",
        },
        {
          repository: "didi-build/failed-one",
          cause: "setup_finished",
          result: "removed",
        },
        { repository: "didi-build/foreman", cause: "not_a_project", result: "removed" },
        {
          repository: "didi-build/launchpad",
          cause: "not_a_project",
          result: "removed",
        },
        { repository: "didi-build/old-one", cause: "window_passed", result: "removed" },
      ],
      problem: null,
    });
    expect([...f.bootstrap.selected].sort()).toEqual(["new-one", "running-one"]);
    // Bootstrap's runs are read only for a project inside the hour.
    expect(
      f.bootstrap.calls.filter((c) => c.startsWith("latestRestart")).sort(),
    ).toEqual([
      "latestRestart done-one",
      "latestRestart failed-one",
      "latestRestart new-one",
      "latestRestart running-one",
    ]);
  });

  it("removes a kept repository once its hour has passed", async () => {
    const f = await setup();
    await f.project("garden-notes");
    await startSetup(f.deps, "garden-notes");
    expect((await f.pass())?.kept).toEqual(["didi-build/garden-notes"]);
    f.later(SETUP_WINDOW_MINUTES - 1);
    expect((await f.pass())?.kept).toEqual(["didi-build/garden-notes"]);
    f.later(1);
    expect((await f.pass())?.removals).toEqual([
      {
        repository: "didi-build/garden-notes",
        cause: "window_passed",
        result: "removed",
      },
    ]);
    expect(f.bootstrap.selected.size).toBe(0);
  });

  it("removes a repository whose Bootstrap runs cannot be read (fail closed)", async () => {
    const f = await setup();
    await f.project("garden-notes", 1);
    f.bootstrap.selected.add("garden-notes");
    f.bootstrap.failRunReads = true;
    expect((await f.pass())?.removals).toEqual([
      {
        repository: "didi-build/garden-notes",
        cause: "setup_unreadable",
        result: "removed",
      },
    ]);
  });

  it("does not take a project of another repository as the one on the list", async () => {
    const f = await setup();
    await f.store.insertProject({
      ...plannedProject("garden-notes"),
      repo: "someone-else/garden-notes",
      id: "75000000-0000-4000-8000-000000000099",
      createdAt: T0,
    });
    f.bootstrap.selected.add("garden-notes");
    expect((await f.pass())?.removals).toMatchObject([
      { repository: "didi-build/garden-notes", cause: "not_a_project" },
    ]);
  });

  it("reports a refused removal with its step and goes on with the next", async () => {
    const f = await setup();
    f.bootstrap.selected.add("foreman");
    f.bootstrap.selected.add("launchpad");
    f.bootstrap.refuse.remove = "token";
    expect((await f.pass())?.removals).toEqual([
      {
        repository: "didi-build/foreman",
        cause: "not_a_project",
        result: "refused",
        step: "token",
      },
      {
        repository: "didi-build/launchpad",
        cause: "not_a_project",
        result: "refused",
        step: "token",
      },
    ]);
    expect(f.bootstrap.calls).toEqual(["list", "remove foreman", "remove launchpad"]);
  });

  it("removes nothing when the list cannot be read, and says so", async () => {
    const f = await setup();
    f.bootstrap.failList = true;
    expect(await f.pass()).toEqual({
      mode: "live",
      kept: [],
      removals: [],
      problem: ACCESS_LIST_UNREADABLE,
    });
    expect(f.bootstrap.calls).toEqual(["list"]);
  });

  it("in dry run reports what it would remove, and removes nothing", async () => {
    const f = await setup({ live: false });
    await f.project("garden-notes", 2);
    for (const name of ["garden-notes", "foreman"]) f.bootstrap.selected.add(name);
    expect(await f.pass()).toEqual({
      mode: "dry_run",
      kept: ["didi-build/garden-notes"],
      removals: [
        {
          repository: "didi-build/foreman",
          cause: "not_a_project",
          result: "would_remove",
        },
      ],
      problem: null,
    });
    expect([...f.bootstrap.selected].sort()).toEqual(["foreman", "garden-notes"]);
    expect(f.bootstrap.calls.some((c) => c.startsWith("remove"))).toBe(false);
  });

  it("does nothing under the kill switch, not even the list", async () => {
    const f = await setup();
    await f.setting("kill_switch", true);
    f.bootstrap.selected.add("foreman");
    expect(await f.pass()).toBeNull();
    expect(f.bootstrap.calls).toEqual([]);
    expect([...f.bootstrap.selected]).toEqual(["foreman"]);
  });
});

describe("the daily check's failed setups (unit, O-114)", () => {
  it("names each project whose restarted Bootstrap run failed, by slug, and each it could not read", async () => {
    const f = await setup();
    await f.project("seed-swap");
    await f.project("garden-notes");
    await f.project("tool-library");
    await f.project("not-started");
    await f.store.insertProject({
      ...plannedProject("elsewhere"),
      repo: "someone-else/elsewhere",
      id: "75000000-0000-4000-8000-000000000098",
      createdAt: T0,
    });
    await f.bootstrap.restart("seed-swap");
    f.bootstrap.finish("seed-swap", "failure");
    await f.bootstrap.restart("garden-notes");
    f.bootstrap.finish("garden-notes", "timed_out");
    await f.bootstrap.restart("tool-library");
    f.bootstrap.finish("tool-library", "success");
    f.bootstrap.calls = [];
    expect(await failedSetups(f.deps, await f.store.listProjects())).toEqual({
      failed: [
        {
          slug: "garden-notes",
          message: "Bootstrap failed for garden-notes; run the register form again",
        },
        {
          slug: "seed-swap",
          message: "Bootstrap failed for seed-swap; run the register form again",
        },
      ],
      unreadable: [],
    });
    // A project of another repository is not one the form set up, so it is not read.
    expect(f.bootstrap.calls).not.toContain("latestRestart elsewhere");
    f.bootstrap.failRunReads = true;
    expect(await failedSetups(f.deps, await f.store.listProjects())).toEqual({
      failed: [],
      unreadable: ["garden-notes", "not-started", "seed-swap", "tool-library"],
    });
  });

  it("drops a failure once the form's next restart succeeds", async () => {
    const f = await setup();
    await f.project("garden-notes");
    await f.bootstrap.restart("garden-notes");
    f.bootstrap.finish("garden-notes", "failure");
    expect(
      (await failedSetups(f.deps, await f.store.listProjects())).failed,
    ).toHaveLength(1);
    await f.bootstrap.restart("garden-notes");
    expect((await failedSetups(f.deps, await f.store.listProjects())).failed).toEqual(
      [],
    );
    f.bootstrap.finish("garden-notes", "success");
    expect((await failedSetups(f.deps, await f.store.listProjects())).failed).toEqual(
      [],
    );
  });
});
