// Seam: unit, Didi's register-project form in the core (D-345, D-346, D-348, O-109), on the
// memory store with a fixed clock and id source, and fakes of the settings file and of GitHub's
// repository calls (src/adapters/github/project-registration-fake.ts). The input checks, the
// switches, the settings check, a project already recorded, reuse against refusal of an existing
// repository, the fail-closed creation token, and the exact project row. Then the setup step of
// D-358 lock (2) (O-114), with the fake of BOOTSTRAP_TOKEN's access and Bootstrap's runs
// (src/adapters/github/bootstrap-fake.ts): the grant, then the restart, a refusal at each step,
// and the form run again picking up where it stopped. Synthetic data only; no real repository,
// token or GitHub call.
import { describe, expect, it } from "vitest";

import { STATE_API_PUBLIC } from "../infra/kubernetes/platform.ts";
import { createFakeBootstrap } from "../src/adapters/github/bootstrap-fake.ts";
import {
  createFakeProjectRepositories,
  createFakeProjectSettings,
  launchpadRepository,
} from "../src/adapters/github/project-registration-fake.ts";
import { createMemoryStore } from "../src/core/memory-store.ts";
import {
  createProjectRegistration,
  DESCRIPTION_MAX_CHARS,
  plannedProject,
  PROJECT_SLUG,
  REGISTER_REFUSALS,
  type ProjectRepositories,
  type RegisterProjectInput,
} from "../src/core/register-project.ts";
import { StoreConflictError, type Json, type Store } from "../src/core/store.ts";

const T0 = new Date("2026-11-07T12:00:00Z");
const SLUG = "garden-notes";
const DESCRIPTION = "A small notes app for the garden club.";

async function setup(
  options: { live?: boolean; listed?: string[]; store?: Store } = {},
) {
  const store = options.store ?? createMemoryStore();
  let n = 0;
  const ids = {
    next: () => `70000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  };
  const clock = { now: () => new Date(T0) };
  const setting = (key: string, value: Json) =>
    store.setSetting({ key, value, updatedBy: "test", updatedAt: T0 });
  await setting("kill_switch", false);
  await setting("dry_run", !(options.live ?? true));
  const projectSettings = createFakeProjectSettings(options.listed ?? [SLUG]);
  const repositories = createFakeProjectRepositories();
  const bootstrap = createFakeBootstrap();
  const deps = {
    store,
    clock,
    ids,
    projectSettings,
    projectRepositories: repositories,
    bootstrapAccess: bootstrap,
    bootstrapRuns: bootstrap,
  };
  const register = (
    input: RegisterProjectInput = { slug: SLUG, description: DESCRIPTION },
    projectRepositories: ProjectRepositories = repositories,
  ) => createProjectRegistration({ ...deps, projectRepositories }).register(input);
  return { store, setting, projectSettings, repositories, bootstrap, register };
}

/** Nothing was asked of GitHub and nothing was recorded. */
async function nothingDone(f: Awaited<ReturnType<typeof setup>>, settingsReads = 0) {
  expect(f.projectSettings.reads).toBe(settingsReads);
  expect(f.repositories.generated).toEqual([]);
  expect(f.repositories.reads).toEqual([]);
  expect(f.bootstrap.calls).toEqual([]);
  expect(await f.store.listProjects()).toEqual([]);
}

describe("the register-project form's input (unit, D-345, O-109)", () => {
  it("refuses a slug outside the project-slug rule before reading anything", async () => {
    for (const slug of [
      "",
      "Garden",
      "-garden",
      "garden_notes",
      "garden.notes",
      "garden notes",
      "a".repeat(101),
      42,
      null,
    ]) {
      const f = await setup();
      const result = await f.register({
        slug: slug as string,
        description: DESCRIPTION,
      });
      expect(result, String(slug)).toEqual({
        outcome: "refused",
        reason: "invalid_slug",
        message: REGISTER_REFUSALS.invalid_slug,
      });
      await nothingDone(f);
    }
  });

  it("is the slug rule of the state API's planning reads and the tunnel's path", () => {
    expect(PROJECT_SLUG.source).toBe("^[a-z0-9][a-z0-9-]{0,99}$");
    expect(STATE_API_PUBLIC.tunnelPath).toContain(PROJECT_SLUG.source.slice(1, -1));
    expect(PROJECT_SLUG.test("a".repeat(100))).toBe(true);
    expect(PROJECT_SLUG.test("rehearsal-2")).toBe(true);
  });

  it("refuses an empty, multi-line, control-character or overlong description", async () => {
    const cases: [unknown, keyof typeof REGISTER_REFUSALS][] = [
      ["", "no_description"],
      ["   \t  ", "no_description"],
      [undefined, "no_description"],
      ["First line\nsecond line", "description_not_one_line"],
      ["First line\r\nsecond line", "description_not_one_line"],
      ["First line\u2028second line", "description_not_one_line"],
      ["A notes\tapp", "description_has_control_characters"],
      ["A notes\u0000app", "description_has_control_characters"],
      ["A notes\u007fapp", "description_has_control_characters"],
      // A right-to-left override and a zero-width space: invisible format characters.
      ["A notes \u202eppa", "description_has_control_characters"],
      ["A notes\u200bapp", "description_has_control_characters"],
      ["a".repeat(DESCRIPTION_MAX_CHARS + 1), "description_too_long"],
    ];
    for (const [description, reason] of cases) {
      const f = await setup();
      const result = await f.register({
        slug: SLUG,
        description: description as string,
      });
      expect(result, JSON.stringify(description)).toEqual({
        outcome: "refused",
        reason,
        message: REGISTER_REFUSALS[reason],
      });
      await nothingDone(f);
    }
  });

  it("trims the description and takes one of exactly the cap", async () => {
    const f = await setup();
    await f.register({ slug: SLUG, description: `  ${DESCRIPTION}  \n` });
    expect(f.repositories.generated).toEqual([
      { name: SLUG, description: DESCRIPTION },
    ]);
    const g = await setup();
    const longest = "b".repeat(DESCRIPTION_MAX_CHARS);
    expect((await g.register({ slug: SLUG, description: longest })).outcome).toBe(
      "registered",
    );
  });

  it("never quotes the input in a refusal", async () => {
    const f = await setup();
    const secretLooking = "fake-value-that-must-not-echo";
    const result = await f.register({
      slug: SLUG,
      description: `${secretLooking}\u0007`,
    });
    expect(JSON.stringify(result)).not.toContain(secretLooking);
    for (const message of Object.values(REGISTER_REFUSALS)) {
      expect(message).not.toMatch(/\$\{/);
    }
  });
});

describe("the register-project form's switches (unit, D-345, O-109)", () => {
  it("refuses under the kill switch before reading, creating or writing anything", async () => {
    const f = await setup();
    await f.setting("kill_switch", true);
    expect(await f.register()).toEqual({
      outcome: "refused",
      reason: "kill_switch",
      message: REGISTER_REFUSALS.kill_switch,
    });
    await nothingDone(f);
  });

  it("in dry run reads the settings, creates and writes nothing, and says what it would do", async () => {
    for (const dryRun of [true, null] as const) {
      const store = createMemoryStore();
      const f = await setup({ store, live: false });
      // Any value but false is dry run, as everywhere else.
      if (dryRun === null) await f.setting("dry_run", "unset");
      const result = await f.register();
      expect(result).toEqual({
        outcome: "dry_run",
        message: expect.stringContaining(
          "nothing was created, recorded, granted or started",
        ) as string,
        wouldCreate: {
          repository: `didi-build/${SLUG}`,
          template: "didi-build/launchpad",
          description: DESCRIPTION,
          private: false,
        },
        wouldRecord: plannedProject(SLUG),
        wouldGrant: { secret: "BOOTSTRAP_TOKEN", repository: `didi-build/${SLUG}` },
        wouldRestart: {
          repository: `didi-build/${SLUG}`,
          workflow: ".github/workflows/bootstrap.yml",
          ref: "main",
        },
      });
      await nothingDone(f, 1);
    }
  });
});

describe("the register-project form's settings check (unit, D-345, O-109)", () => {
  it("refuses a slug not listed in the settings file on main, creating nothing", async () => {
    const f = await setup({ listed: ["rehearsal", "garden"] });
    expect(await f.register()).toEqual({
      outcome: "refused",
      reason: "not_in_settings",
      message: REGISTER_REFUSALS.not_in_settings,
    });
    await nothingDone(f, 1);
  });

  it("refuses when the settings file cannot be read, creating nothing", async () => {
    const f = await setup();
    f.projectSettings.listed = "fail";
    expect(await f.register()).toMatchObject({
      outcome: "refused",
      reason: "settings_unreadable",
    });
    await nothingDone(f, 1);
  });
});

describe("registering a project (unit, D-345, D-346, D-348, O-109)", () => {
  it("creates the repository from Launchpad and records exactly the project row", async () => {
    const f = await setup();
    const result = await f.register();
    const row = {
      id: "70000000-0000-4000-8000-000000000001",
      slug: SLUG,
      name: SLUG,
      repo: `didi-build/${SLUG}`,
      linearProjectId: null,
      galleryPathOverride: null,
      privilegedPathsExtra: [],
      prodRequiresApproval: true,
      stagingUrl: `https://${SLUG}.didi.build`,
      createdAt: T0,
    };
    expect(result).toEqual({
      outcome: "registered",
      repository: "created",
      project: row,
      setup: "started",
    });
    expect(f.repositories.generated).toEqual([
      { name: SLUG, description: DESCRIPTION },
    ]);
    expect(f.repositories.reads).toEqual([]);
    expect(await f.store.listProjects()).toEqual([row]);
  });

  it("is already_registered when the store has the slug and its setup finished, and creates nothing", async () => {
    const f = await setup();
    await f.register();
    f.bootstrap.finish(SLUG, "success");
    const again = await f.register();
    expect(again).toEqual({
      outcome: "already_registered",
      slug: SLUG,
      repo: `didi-build/${SLUG}`,
    });
    expect(f.repositories.generated).toHaveLength(1);
    expect(await f.store.listProjects()).toHaveLength(1);
    // The second run only read Bootstrap's newest restarted run.
    expect(f.bootstrap.calls).toEqual([
      `grant ${SLUG}`,
      `restart ${SLUG}`,
      `latestRestart ${SLUG}`,
    ]);
  });

  it("reuses the repository an earlier run created and failed to record", async () => {
    const f = await setup();
    f.repositories.existing.set(SLUG, launchpadRepository(SLUG));
    const result = await f.register();
    expect(result).toMatchObject({ outcome: "registered", repository: "reused" });
    expect(f.repositories.reads).toEqual([SLUG]);
    expect(await f.store.listProjects()).toHaveLength(1);
  });

  it("refuses an existing repository that is not Launchpad's, not public or not exactly this name", async () => {
    const cases: [Partial<ReturnType<typeof launchpadRepository>>, string][] = [
      [{ templateFullName: null }, "existing_not_from_template"],
      [{ templateFullName: "didi-build/other-template" }, "existing_not_from_template"],
      [{ private: true }, "existing_not_public"],
      [{ visibility: "internal" }, "existing_not_public"],
      [{ visibility: "private" }, "existing_not_public"],
      [{ fullName: "didi-build/Garden-notes" }, "existing_other_name"],
      [{ fullName: "someone-else/garden-notes" }, "existing_other_name"],
    ];
    for (const [change, reason] of cases) {
      const f = await setup();
      f.repositories.existing.set(SLUG, { ...launchpadRepository(SLUG), ...change });
      expect(await f.register(), reason).toMatchObject({ outcome: "refused", reason });
      expect(await f.store.listProjects()).toEqual([]);
      expect(f.repositories.generated).toHaveLength(1);
    }
  });

  it("refuses when GitHub did not create it and nothing can be read under the name", async () => {
    const missing = await setup();
    missing.repositories.nextGenerate = { kind: "not_created" };
    expect(await missing.register()).toMatchObject({ reason: "existing_unreadable" });
    const failing = await setup();
    failing.repositories.existing.set(SLUG, launchpadRepository(SLUG));
    failing.repositories.failReads = true;
    expect(await failing.register()).toMatchObject({ reason: "existing_unreadable" });
    for (const f of [missing, failing])
      expect(await f.store.listProjects()).toEqual([]);
  });

  it("fails closed on the creation token: one attempt, no read, nothing recorded", async () => {
    const f = await setup();
    f.repositories.nextGenerate = { kind: "refused", step: "creation_token" };
    expect(await f.register()).toEqual({
      outcome: "refused",
      reason: "creation_token_refused",
      message: REGISTER_REFUSALS.creation_token_refused,
    });
    expect(f.repositories.generated).toHaveLength(1);
    expect(f.repositories.reads).toEqual([]);
    expect(await f.store.listProjects()).toEqual([]);
  });

  it("refuses a refused or failed create, and a create whose answer is not the repository asked for", async () => {
    const cases = [
      [{ kind: "refused", step: "create" }, "create_refused"],
      ["throw", "create_refused"],
      [{ kind: "created", repository: null }, "created_unexpected"],
      [
        {
          kind: "created",
          repository: { ...launchpadRepository(SLUG), private: true },
        },
        "created_unexpected",
      ],
      [
        {
          kind: "created",
          repository: {
            ...launchpadRepository(SLUG),
            fullName: "didi-build/garden-notes-1",
          },
        },
        "created_unexpected",
      ],
    ] as const;
    for (const [answer, reason] of cases) {
      const f = await setup();
      f.repositories.nextGenerate = structuredClone(answer) as never;
      expect(await f.register(), reason).toMatchObject({ outcome: "refused", reason });
      expect(f.repositories.reads).toEqual([]);
      expect(await f.store.listProjects()).toEqual([]);
    }
  });

  it("records nothing when a switch is turned on while the repository is created", async () => {
    for (const [key, value] of [
      ["kill_switch", true],
      ["dry_run", true],
    ] as const) {
      const f = await setup();
      const slow: ProjectRepositories = {
        ...f.repositories,
        generate: async (request) => {
          await f.setting(key, value);
          return f.repositories.generate(request);
        },
      };
      expect(await f.register(undefined, slow), key).toEqual({
        outcome: "refused",
        reason: "switch_turned_on",
        message: REGISTER_REFUSALS.switch_turned_on,
      });
      expect(await f.store.listProjects()).toEqual([]);
      // Nothing recorded, so no access is granted and Bootstrap is not started (O-114).
      expect(f.bootstrap.calls).toEqual([]);
      // Once the switch is off again, the next run reuses the repository and records the project.
      await f.setting(key, !value);
      expect(await f.register()).toMatchObject({ repository: "reused" });
    }
  });

  it("ends a concurrent insert of the same slug as already_registered", async () => {
    const inner = createMemoryStore();
    // A store where the other run's row is not visible yet, so only the unique slug stops the insert.
    const raced: Store = {
      ...inner,
      getProjectBySlug: async () => null,
      transaction: (work) =>
        inner.transaction((tx) => work({ ...tx, getProjectBySlug: async () => null })),
    };
    const f = await setup({ store: raced });
    await inner.insertProject({
      ...plannedProject(SLUG),
      id: "71000000-0000-4000-8000-000000000001",
      createdAt: T0,
    });
    expect(await f.register()).toEqual({
      outcome: "already_registered",
      slug: SLUG,
      repo: `didi-build/${SLUG}`,
    });
    expect(await inner.listProjects()).toHaveLength(1);
  });

  it("does not swallow another store conflict", async () => {
    const inner = createMemoryStore();
    const failing: Store = {
      ...inner,
      transaction: () =>
        Promise.reject(new StoreConflictError("projects_pkey", "Duplicate key")),
    };
    const f = await setup({ store: failing });
    await expect(f.register()).rejects.toThrow(StoreConflictError);
  });

  it("two runs at once give one project, the other already_registered", async () => {
    const f = await setup();
    const results = await Promise.all([f.register(), f.register()]);
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "already_registered",
      "registered",
    ]);
    expect(await f.store.listProjects()).toHaveLength(1);
  });

  it("records every project with the shared privileged paths and production behind Didi", () => {
    for (const slug of ["foreman", "rehearsal", SLUG]) {
      expect(plannedProject(slug)).toMatchObject({
        privilegedPathsExtra: [],
        prodRequiresApproval: true,
        stagingUrl: `https://${slug}.didi.build`,
      });
    }
  });
});

describe("the register form's setup step (unit, D-358 lock (2), O-114)", () => {
  const REPO = `didi-build/${SLUG}`;

  it("once the project is recorded, grants the repository access, then restarts Bootstrap", async () => {
    const f = await setup();
    const result = await f.register();
    expect(result).toMatchObject({ outcome: "registered", setup: "started" });
    expect(f.bootstrap.calls).toEqual([`grant ${SLUG}`, `restart ${SLUG}`]);
    expect([...f.bootstrap.selected]).toEqual([SLUG]);
    expect(f.bootstrap.runs.get(SLUG)).toEqual([
      { event: "workflow_dispatch", status: "queued", conclusion: null },
    ]);
  });

  it("grants and restarts for a reused repository too", async () => {
    const f = await setup();
    f.repositories.existing.set(SLUG, launchpadRepository(SLUG));
    expect(await f.register()).toMatchObject({
      repository: "reused",
      setup: "started",
    });
    expect(f.bootstrap.calls).toEqual([`grant ${SLUG}`, `restart ${SLUG}`]);
  });

  it("grants nothing when nothing is recorded", async () => {
    const f = await setup();
    f.repositories.nextGenerate = { kind: "refused", step: "creation_token" };
    await f.register();
    expect(f.bootstrap.calls).toEqual([]);
  });

  it("stops at a refused grant with fixed text: the project stays recorded, Bootstrap is not started, and nothing is tried again", async () => {
    const cases = [
      ["token", "grant_token_refused"],
      ["not_selected", "secret_not_selected"],
      ["call", "grant_refused"],
    ] as const;
    for (const [step, reason] of cases) {
      const f = await setup();
      f.bootstrap.refuse.grant = step;
      expect(await f.register(), step).toEqual({
        outcome: "refused",
        reason,
        message: REGISTER_REFUSALS[reason],
      });
      expect(REGISTER_REFUSALS[reason]).toContain("picks up where it stopped");
      expect(f.bootstrap.calls).toEqual([`grant ${SLUG}`]);
      expect(await f.store.listProjects()).toHaveLength(1);
    }
  });

  it("stops at a refused restart with fixed text, leaving the access for the window", async () => {
    const cases = [
      ["token", "restart_token_refused"],
      ["call", "restart_refused"],
      ["not_selected", "restart_refused"],
    ] as const;
    for (const [step, reason] of cases) {
      const f = await setup();
      f.bootstrap.refuse.restart = step;
      expect(await f.register(), step).toEqual({
        outcome: "refused",
        reason,
        message: REGISTER_REFUSALS[reason],
      });
      expect(f.bootstrap.calls).toEqual([`grant ${SLUG}`, `restart ${SLUG}`]);
      expect([...f.bootstrap.selected]).toEqual([SLUG]);
    }
  });

  it("names GitHub's status beside a refused restart, so the form says why (O-114)", async () => {
    const f = await setup();
    f.bootstrap.refuse.restart = "call";
    f.bootstrap.restartStatus = 404;
    expect(await f.register()).toEqual({
      outcome: "refused",
      reason: "restart_refused",
      message: REGISTER_REFUSALS.restart_refused,
      githubStatus: 404,
    });
  });

  it("treats a port that throws as a refused call, and tries nothing again", async () => {
    const f = await setup();
    const throwing = {
      ...f.bootstrap,
      grant: async () => {
        f.bootstrap.calls.push(`grant ${SLUG}`);
        throw new Error("the connection dropped");
      },
    };
    const result = await createProjectRegistration({
      store: f.store,
      clock: { now: () => new Date(T0) },
      ids: { next: () => "73000000-0000-4000-8000-000000000001" },
      projectSettings: f.projectSettings,
      projectRepositories: f.repositories,
      bootstrapAccess: throwing,
      bootstrapRuns: f.bootstrap,
    }).register({ slug: SLUG, description: DESCRIPTION });
    expect(result).toMatchObject({ outcome: "refused", reason: "grant_refused" });
    expect(f.bootstrap.calls).toEqual([`grant ${SLUG}`]);
  });

  it("run again after a refused grant or restart, picks up where it stopped: one row, a new grant and a restart", async () => {
    for (const refused of ["grant", "restart"] as const) {
      const f = await setup();
      f.bootstrap.refuse[refused] = "call";
      await f.register();
      f.bootstrap.refuse = {};
      f.bootstrap.calls = [];
      expect(await f.register(), refused).toEqual({
        outcome: "setup_restarted",
        slug: SLUG,
        repo: REPO,
      });
      // The repository is checked as one to reuse before it is given access again.
      expect(f.repositories.reads).toEqual([SLUG]);
      expect(f.bootstrap.calls).toEqual([
        `latestRestart ${SLUG}`,
        `grant ${SLUG}`,
        `restart ${SLUG}`,
      ]);
      expect(f.repositories.generated).toHaveLength(1);
      expect(await f.store.listProjects()).toHaveLength(1);
    }
  });

  it("run again after Bootstrap failed, grants and restarts again; after it succeeded, does nothing", async () => {
    const f = await setup();
    await f.register();
    f.bootstrap.finish(SLUG, "failure");
    expect(await f.register()).toMatchObject({ outcome: "setup_restarted" });
    expect(f.bootstrap.runs.get(SLUG)).toHaveLength(2);
    f.bootstrap.finish(SLUG, "success");
    f.bootstrap.calls = [];
    expect(await f.register()).toMatchObject({ outcome: "already_registered" });
    expect(f.bootstrap.calls).toEqual([`latestRestart ${SLUG}`]);
  });

  it("treats every conclusion but success as a failed setup to restart", async () => {
    for (const conclusion of ["cancelled", "timed_out", "startup_failure", "skipped"]) {
      const f = await setup();
      await f.register();
      f.bootstrap.finish(SLUG, conclusion);
      expect(await f.register(), conclusion).toMatchObject({
        outcome: "setup_restarted",
      });
    }
  });

  it("while Bootstrap's restarted run is going, grants and starts nothing", async () => {
    const f = await setup();
    await f.register();
    for (const status of ["queued", "in_progress", "waiting"]) {
      const run = f.bootstrap.runs.get(SLUG)?.at(-1);
      if (run) run.status = status;
      f.bootstrap.calls = [];
      expect(await f.register(), status).toEqual({
        outcome: "refused",
        reason: "bootstrap_running",
        message: REGISTER_REFUSALS.bootstrap_running,
      });
      expect(f.bootstrap.calls).toEqual([`latestRestart ${SLUG}`]);
    }
  });

  it("refuses, granting nothing, when Bootstrap's runs cannot be read", async () => {
    const f = await setup();
    f.bootstrap.refuse.restart = "call";
    await f.register();
    f.bootstrap.refuse = {};
    f.bootstrap.failRunReads = true;
    f.bootstrap.calls = [];
    expect(await f.register()).toEqual({
      outcome: "refused",
      reason: "setup_unreadable",
      message: REGISTER_REFUSALS.setup_unreadable,
    });
    expect(f.bootstrap.calls).toEqual([`latestRestart ${SLUG}`]);
  });

  it("gives access again only to a repository it would reuse", async () => {
    const changes: Partial<ReturnType<typeof launchpadRepository>>[] = [
      { templateFullName: null },
      { private: true },
      { fullName: "didi-build/Garden-notes" },
    ];
    for (const change of [...changes, "missing", "unreadable"] as const) {
      const f = await setup();
      f.bootstrap.refuse.restart = "call";
      await f.register();
      f.bootstrap.refuse = {};
      if (change === "missing") f.repositories.existing.delete(SLUG);
      else if (change === "unreadable") f.repositories.failReads = true;
      else
        f.repositories.existing.set(SLUG, { ...launchpadRepository(SLUG), ...change });
      f.bootstrap.calls = [];
      expect(await f.register(), JSON.stringify(change)).toEqual({
        outcome: "refused",
        reason: "registered_repository_unchecked",
        message: REGISTER_REFUSALS.registered_repository_unchecked,
      });
      expect(f.bootstrap.calls).toEqual([`latestRestart ${SLUG}`]);
    }
  });

  it("gives no access to a recorded project whose repository is not didi-build/<slug>", async () => {
    const f = await setup();
    await f.store.insertProject({
      ...plannedProject(SLUG),
      repo: "didi-build/other-name",
      id: "74000000-0000-4000-8000-000000000001",
      createdAt: T0,
    });
    f.repositories.existing.set(SLUG, launchpadRepository(SLUG));
    expect(await f.register()).toMatchObject({
      reason: "registered_repository_unchecked",
    });
    expect(f.repositories.reads).toEqual([]);
    expect(f.bootstrap.calls).toEqual([`latestRestart ${SLUG}`]);
  });

  it("in dry run, on a recorded project whose setup has not finished, says what it would grant and restart, and does neither", async () => {
    const f = await setup();
    f.bootstrap.refuse.grant = "call";
    await f.register();
    f.bootstrap.refuse = {};
    await f.setting("dry_run", true);
    f.bootstrap.calls = [];
    expect(await f.register()).toEqual({
      outcome: "dry_run",
      message: expect.stringContaining("nothing was granted or started") as string,
      wouldCreate: null,
      wouldRecord: null,
      wouldGrant: { secret: "BOOTSTRAP_TOKEN", repository: REPO },
      wouldRestart: {
        repository: REPO,
        workflow: ".github/workflows/bootstrap.yml",
        ref: "main",
      },
    });
    expect(f.bootstrap.calls).toEqual([`latestRestart ${SLUG}`]);
    expect(f.repositories.reads).toEqual([]);
  });

  it("under the kill switch, on a recorded project, reads and grants nothing", async () => {
    const f = await setup();
    f.bootstrap.refuse.grant = "call";
    await f.register();
    f.bootstrap.refuse = {};
    await f.setting("kill_switch", true);
    f.bootstrap.calls = [];
    expect(await f.register()).toMatchObject({ reason: "kill_switch" });
    expect(f.bootstrap.calls).toEqual([]);
  });

  it("quotes no token or input in the setup refusals", () => {
    for (const reason of [
      "grant_token_refused",
      "secret_not_selected",
      "grant_refused",
      "restart_token_refused",
      "restart_refused",
      "setup_unreadable",
      "bootstrap_running",
      "registered_repository_unchecked",
    ] as const) {
      expect(REGISTER_REFUSALS[reason]).not.toMatch(/\$\{|garden/);
    }
  });
});
