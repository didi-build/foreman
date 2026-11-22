// Seam: unit, Didi's New project form in the core (ADR 0118 appendix C, D-434, D-435, D-442 to
// D-447, O-161), on the memory store with a fixed clock and id source, the fake deploy target
// (src/adapters/deploy/fake.ts), and fakes of the settings, the workflow starts, the repositories
// (src/adapters/github/new-project-fake.ts), the DNS lookup (src/adapters/dns/fake.ts) and
// BOOTSTRAP_TOKEN's access and Bootstrap's runs (src/adapters/github/bootstrap-fake.ts). The input
// checks, the switches, the exact order of the effects and their values, find before create at
// each step, a run again after a failure at each step, a short name already in use, and what Didi
// sees. Synthetic data only; no real repository, token, database or GitHub call.
import { describe, expect, it } from "vitest";

import {
  createFakeClusterTarget,
  createFakeStagingTarget,
} from "../src/adapters/deploy/fake.ts";
import { createFakePublicNames } from "../src/adapters/dns/fake.ts";
import { createFakeBootstrap } from "../src/adapters/github/bootstrap-fake.ts";
import {
  createFakeProjectRepositories,
  createFakeProjectSettings,
  createFakeProjectWorkflows,
  launchpadRepository,
  STANDARD_QUOTA,
} from "../src/adapters/github/new-project-fake.ts";
import type { ProjectSetUp } from "../src/core/deploy-target.ts";
import { createMemoryStore } from "../src/core/memory-store.ts";
import {
  createNewProjectForm,
  NEW_PROJECT_MESSAGES,
  NEW_PROJECT_REFUSALS,
  NEW_PROJECT_STEPS,
  NOT_REACHED_TEXT,
  plannedProject,
  projectFileText,
  settingsCommitMessage,
  type NewProjectInput,
  type NewProjectRefusal,
  type NewProjectResult,
  type StepOutcome,
} from "../src/core/new-project.ts";
import type { ProjectEntry } from "../src/core/project-entry.ts";
import type { Json } from "../src/core/store.ts";

const T0 = new Date("2026-11-21T12:00:00Z");
const SLUG = "garden-notes";
const RUN_ID = "0192f0a0-1234-4abc-8def-0123456789ab";
const INPUT: NewProjectInput = {
  slug: SLUG,
  displayName: "Garden Notes",
  purpose: "A small notes app for the garden club.",
  collectsPersonalData: true,
  runId: RUN_ID,
};
const char = (code: number) => String.fromCharCode(code);

/** The file the form writes for INPUT, on `createdOn`. */
const entryFor = (createdOn = "2026-11-21", change: Partial<ProjectEntry> = {}) => ({
  schema: 1 as const,
  slug: SLUG,
  displayName: INPUT.displayName,
  purpose: INPUT.purpose,
  collectsPersonalData: true,
  quota: { ...STANDARD_QUOTA },
  deployTarget: "cloudflare" as const,
  createdOn,
  ...change,
});

async function setup(options: { live?: boolean } = {}) {
  const store = createMemoryStore();
  let n = 0;
  const ids = {
    next: () => `76000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  };
  const setting = (key: string, value: Json) =>
    store.setSetting({ key, value, updatedBy: "test", updatedAt: T0 });
  await setting("kill_switch", false);
  await setting("dry_run", !(options.live ?? true));
  const target = createFakeStagingTarget();
  const settings = createFakeProjectSettings();
  const workflows = createFakeProjectWorkflows();
  const repositories = createFakeProjectRepositories();
  const names = createFakePublicNames();
  const bootstrap = createFakeBootstrap();
  // Every effect, in the order the form makes it.
  const order: string[] = [];
  /** What the next setUp answers instead of the fake target, once. */
  const next: { setUp: ProjectSetUp | null; beforeSetUp?: () => Promise<void> } = {
    setUp: null,
  };
  const deps = {
    store: {
      ...store,
      transaction: ((work) => {
        order.push("record");
        return store.transaction(work);
      }) as typeof store.transaction,
    },
    clock: { now: () => new Date(T0) },
    ids,
    targets: {
      cloudflare: {
        async setUp(request: Parameters<typeof target.setUp>[0]) {
          order.push(request.dryRun ? "setUp dry run" : "setUp");
          await next.beforeSetUp?.();
          const answer = next.setUp;
          next.setUp = null;
          return answer ?? target.setUp(request);
        },
      },
      cluster: createFakeClusterTarget(),
    },
    projectSettings: {
      standardQuota: () => settings.standardQuota(),
      readFile: (slug: string) => settings.readFile(slug),
      createFile: (request: Parameters<typeof settings.createFile>[0]) => {
        order.push("createFile");
        return settings.createFile(request);
      },
    },
    projectWorkflows: {
      start: (commit: string) => {
        order.push("start");
        return workflows.start(commit);
      },
    },
    projectRepositories: {
      read: (name: string) => repositories.read(name),
      generate: (request: Parameters<typeof repositories.generate>[0]) => {
        order.push("generate");
        return repositories.generate(request);
      },
    },
    publicNames: names,
    bootstrapAccess: {
      ...bootstrap,
      grant: (name: string) => {
        order.push("grant");
        return bootstrap.grant(name);
      },
    },
    bootstrapRuns: {
      latestRestart: (name: string) => bootstrap.latestRestart(name),
      restart: (name: string, inputs: Parameters<typeof bootstrap.restart>[1]) => {
        order.push("restart");
        return bootstrap.restart(name, inputs);
      },
    },
  };
  const create = (input: NewProjectInput = INPUT) =>
    createNewProjectForm(deps).create(input);
  return {
    store,
    setting,
    target,
    settings,
    workflows,
    repositories,
    names,
    bootstrap,
    order,
    next,
    create,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** Nothing was created, written, started or recorded. */
async function nothingMade(f: Fixture) {
  expect(f.order.filter((o) => o !== "setUp dry run")).toEqual([]);
  expect(f.target.setUps.filter((s) => !s.dryRun)).toEqual([]);
  expect(f.settings.creates).toEqual([]);
  expect(f.workflows.starts).toEqual([]);
  expect(f.repositories.generated).toEqual([]);
  expect(f.bootstrap.calls.filter((c) => !c.startsWith("latestRestart"))).toEqual([]);
  expect(await f.store.listProjects()).toEqual([]);
}

/** Nothing was read either. */
async function nothingRead(f: Fixture) {
  await nothingMade(f);
  expect(f.order).toEqual([]);
  expect(f.settings.reads).toEqual([]);
  expect(f.repositories.reads).toEqual([]);
  expect(f.names.lookups).toEqual([]);
  expect(f.bootstrap.calls).toEqual([]);
}

const outcomes = (result: NewProjectResult) =>
  result.steps.map((l) => `${l.step} ${l.outcome}`);

const refusal = (reason: NewProjectRefusal) => ({
  outcome: "refused",
  reason,
  message: NEW_PROJECT_REFUSALS[reason],
});

describe("the New project form's input (unit, D-435, O-161)", () => {
  it("refuses a short name outside the project file's rule, and foreman, before reading anything", async () => {
    const bad: unknown[] = [
      "",
      "Garden",
      "-garden",
      "garden-",
      "garden--notes",
      "xn--garden",
      "garden_notes",
      "garden.notes",
      "garden notes",
      "a".repeat(48),
      42,
      null,
    ];
    for (const slug of bad) {
      const f = await setup();
      expect(await f.create({ ...INPUT, slug: slug as string }), String(slug)).toEqual({
        ...refusal("invalid_slug"),
        steps: [],
        links: {},
        next: [],
      });
      await nothingRead(f);
    }
    const f = await setup();
    expect(await f.create({ ...INPUT, slug: "foreman" })).toMatchObject(
      refusal("reserved_slug"),
    );
    await nothingRead(f);
    const longest = await setup();
    expect((await longest.create({ ...INPUT, slug: "a".repeat(47) })).outcome).toBe(
      "created",
    );
  });

  it("refuses a display name, purpose or personal-data answer outside the file's rules", async () => {
    const cases: [Partial<NewProjectInput>, NewProjectRefusal][] = [
      [{ displayName: "" }, "invalid_display_name"],
      [{ displayName: "   " }, "invalid_display_name"],
      [{ displayName: "a".repeat(61) }, "invalid_display_name"],
      [{ displayName: "Garden\nNotes" }, "invalid_display_name"],
      [{ displayName: `Garden${char(0x2028)}Notes` }, "invalid_display_name"],
      [{ displayName: `Garden${char(0)}Notes` }, "invalid_display_name"],
      [{ displayName: `Garden${char(0x200b)}Notes` }, "invalid_display_name"],
      [{ displayName: 42 as unknown as string }, "invalid_display_name"],
      [{ purpose: "" }, "invalid_purpose"],
      [{ purpose: "a".repeat(201) }, "invalid_purpose"],
      [{ purpose: "One line\r\nand another" }, "invalid_purpose"],
      [{ purpose: `A notes${char(0x202e)}app` }, "invalid_purpose"],
      [{ purpose: undefined as unknown as string }, "invalid_purpose"],
      [{ collectsPersonalData: "yes" as unknown as boolean }, "invalid_personal_data"],
      [
        { collectsPersonalData: undefined as unknown as boolean },
        "invalid_personal_data",
      ],
    ];
    for (const [change, reason] of cases) {
      const f = await setup();
      expect(await f.create({ ...INPUT, ...change }), JSON.stringify(change)).toEqual({
        ...refusal(reason),
        steps: [],
        links: {},
        next: [],
      });
      await nothingRead(f);
    }
  });

  it("trims the display name and the purpose, and takes each at its cap", async () => {
    const f = await setup();
    await f.create({
      ...INPUT,
      displayName: `  ${INPUT.displayName} `,
      purpose: `\t${INPUT.purpose}  `,
    });
    expect(f.repositories.generated).toEqual([
      { name: SLUG, description: INPUT.purpose },
    ]);
    expect((await f.store.getProjectBySlug(SLUG))?.name).toBe(INPUT.displayName);
    const g = await setup();
    const result = await g.create({
      ...INPUT,
      displayName: "d".repeat(60),
      purpose: "p".repeat(200),
    });
    expect(result.outcome).toBe("created");
  });

  it("never quotes the input in a refusal", async () => {
    const f = await setup();
    const echo = "fake-value-that-must-not-echo";
    const result = await f.create({ ...INPUT, purpose: `${echo}${char(7)}` });
    expect(JSON.stringify(result)).not.toContain(echo);
    for (const message of Object.values(NEW_PROJECT_REFUSALS)) {
      expect(message).not.toContain(SLUG);
      expect(message).not.toMatch(/\$\{/);
    }
  });
});

describe("the New project form's switches (unit, O-161)", () => {
  it("refuses under the kill switch before reading anything", async () => {
    const f = await setup();
    await f.setting("kill_switch", true);
    expect(await f.create()).toEqual({
      ...refusal("kill_switch"),
      steps: [],
      links: {},
      next: [],
    });
    await nothingRead(f);
  });

  it("in dry run only reads, and says what each step would do and the file it would write", async () => {
    for (const value of [true, "unset"] as const) {
      const f = await setup({ live: false });
      // Any value but false is dry run, as everywhere else.
      await f.setting("dry_run", value);
      const result = await f.create();
      expect(result).toEqual({
        outcome: "dry_run",
        message: NEW_PROJECT_MESSAGES.dry_run,
        steps: [
          {
            step: "database",
            outcome: "would_create",
            text: "Would create the D1 database garden-notes-staging, in Eastern North America (D-447).",
          },
          {
            step: "placeholder",
            outcome: "would_create",
            text: "Would upload the placeholder Worker garden-notes-staging: a page at / and an answer at /api/health (D-438).",
          },
          {
            step: "settings_file",
            outcome: "would_create",
            text: "Would write projects/garden-notes.json to didi-build/foreman-projects, with the standard size and the Cloudflare target.",
          },
          {
            step: "workflows",
            outcome: "would_start",
            text: "Would start the Platform and Infra runs on didi-build/foreman with the settings commit.",
          },
          {
            step: "repository",
            outcome: "would_create",
            text: "Would create didi-build/garden-notes from didi-build/launchpad, public, with the purpose as its description.",
          },
          {
            step: "record",
            outcome: "would_create",
            text: "Would record the project: staging at https://garden-notes.didi.build, the Cloudflare target, no production.",
          },
          {
            step: "bootstrap",
            outcome: "would_start",
            text: "Would give didi-build/garden-notes access to BOOTSTRAP_TOKEN and start Bootstrap on main with the display name and the personal-data answer.",
          },
        ],
        links: {},
        wouldWrite: entryFor(),
        next: [
          "Turn dry run off and run the form again with the same values to create the project.",
        ],
      });
      expect(f.order).toEqual(["setUp dry run"]);
      expect(f.target.setUps).toEqual([
        {
          slug: SLUG,
          displayName: INPUT.displayName,
          purpose: INPUT.purpose,
          dryRun: true,
        },
      ]);
      expect(f.settings.reads).toEqual(["quota", SLUG]);
      expect(f.names.lookups).toEqual(["garden-notes.didi.build"]);
      await nothingMade(f);
    }
  });

  it("in dry run on a project an earlier run began, says what is found and reads Bootstrap's run", async () => {
    const f = await setup();
    await f.create();
    await f.setting("dry_run", true);
    f.order.length = 0;
    const result = await f.create();
    expect(outcomes(result)).toEqual([
      "database found",
      "placeholder skipped",
      "settings_file found",
      "workflows would_start",
      "repository found",
      "record found",
      "bootstrap skipped",
    ]);
    expect(result.links).toEqual({
      settingsCommit: `https://github.com/didi-build/foreman-projects/commit/${"c".repeat(39)}1`,
      repository: "https://github.com/didi-build/garden-notes",
    });
    expect(f.order).toEqual(["setUp dry run"]);
    f.bootstrap.failRunReads = true;
    expect(await f.create()).toMatchObject(refusal("setup_unreadable"));
  });

  it("stops before the next step when a switch is turned on during a run", async () => {
    const f = await setup();
    f.next.beforeSetUp = () => f.setting("kill_switch", true);
    const result = await f.create();
    expect(result).toMatchObject(refusal("switch_turned_on"));
    expect(outcomes(result)).toEqual([
      "database created",
      "placeholder created",
      "settings_file refused",
      "workflows not_reached",
      "repository not_reached",
      "record not_reached",
      "bootstrap not_reached",
    ]);
    expect(f.order).toEqual(["setUp"]);
    // Dry run turned on before the row: the transaction reads both again and records nothing.
    const g = await setup();
    const repository = g.repositories.generate.bind(g.repositories);
    g.repositories.generate = async (request) => {
      await g.setting("dry_run", true);
      return repository(request);
    };
    const stopped = await g.create();
    expect(stopped).toMatchObject(refusal("switch_turned_on"));
    expect(stopped.steps.find((l) => l.outcome === "refused")?.step).toBe("record");
    expect(await g.store.listProjects()).toEqual([]);
  });
});

describe("creating a project (unit, ADR 0118 appendix C, O-161)", () => {
  it("makes each piece in the appendix's order, with exactly these values", async () => {
    const f = await setup();
    const result = await f.create();
    expect(f.order).toEqual([
      "setUp",
      "createFile",
      "start",
      "generate",
      "record",
      "grant",
      "restart",
    ]);
    // 1 and 2: the database and the placeholder, with the page's texts.
    expect(f.target.setUps).toEqual([
      { slug: SLUG, displayName: INPUT.displayName, purpose: INPUT.purpose },
    ]);
    // 3: the file, created only, in appendix A's format, its message naming the form and its run.
    const text = projectFileText(entryFor());
    expect(text).toBe(
      [
        "{",
        '  "schema": 1,',
        '  "slug": "garden-notes",',
        '  "displayName": "Garden Notes",',
        '  "purpose": "A small notes app for the garden club.",',
        '  "collectsPersonalData": true,',
        '  "quota": {',
        '    "pods": 12,',
        '    "cpu": "6",',
        '    "memory": "5Gi",',
        '    "ephemeralStorage": "11Gi",',
        '    "storage": "3Gi",',
        '    "persistentVolumeClaims": 3',
        "  },",
        '  "deployTarget": "cloudflare",',
        '  "createdOn": "2026-11-21"',
        "}",
        "",
      ].join("\n"),
    );
    expect(f.settings.creates).toEqual([
      {
        slug: SLUG,
        text,
        message: `Add project garden-notes (New project form, Windmill run ${RUN_ID}, ADR 0118)`,
      },
    ]);
    const commit = `${"c".repeat(39)}1`;
    // 4: both runs, with the commit that holds the file.
    expect(f.workflows.starts).toEqual([commit]);
    // 5: the repository, public, with the purpose as its description.
    expect(f.repositories.generated).toEqual([
      { name: SLUG, description: INPUT.purpose },
    ]);
    // 6: the row, with the display name and the Cloudflare target.
    expect(await f.store.listProjects()).toEqual([
      {
        id: "76000000-0000-4000-8000-000000000001",
        slug: SLUG,
        name: "Garden Notes",
        repo: "didi-build/garden-notes",
        linearProjectId: null,
        galleryPathOverride: null,
        privilegedPathsExtra: [],
        prodRequiresApproval: true,
        stagingUrl: "https://garden-notes.didi.build",
        deployTarget: "cloudflare",
        createdAt: T0,
      },
    ]);
    // 7: the grant, then Bootstrap with the two inputs.
    expect(f.bootstrap.calls).toEqual([`grant ${SLUG}`, `restart ${SLUG}`]);
    expect(f.bootstrap.restartInputs).toEqual([
      { displayName: "Garden Notes", collectsPersonalData: true },
    ]);
    expect(result).toEqual({
      outcome: "created",
      message: NEW_PROJECT_MESSAGES.created,
      steps: [
        {
          step: "database",
          outcome: "created",
          text: "Created the D1 database garden-notes-staging, in Eastern North America (D-447).",
        },
        {
          step: "placeholder",
          outcome: "created",
          text: "Uploaded the placeholder Worker garden-notes-staging: a page at / and an answer at /api/health (D-438).",
        },
        {
          step: "settings_file",
          outcome: "created",
          text: "Wrote projects/garden-notes.json to didi-build/foreman-projects, with the standard size and the Cloudflare target.",
        },
        {
          step: "workflows",
          outcome: "started",
          text: "Started the Platform and Infra runs on didi-build/foreman with the settings commit. Each applies with no approval when its plan only adds this project (D-378); otherwise it waits for your approval in GitHub, and its summary says why.",
        },
        {
          step: "repository",
          outcome: "created",
          text: "Created didi-build/garden-notes from didi-build/launchpad, public, with the purpose as its description.",
        },
        {
          step: "record",
          outcome: "created",
          text: "Recorded the project: staging at https://garden-notes.didi.build, the Cloudflare target, no production.",
        },
        {
          step: "bootstrap",
          outcome: "started",
          text: "Gave didi-build/garden-notes access to BOOTSTRAP_TOKEN and started Bootstrap on main with the display name and the personal-data answer.",
        },
      ],
      links: {
        settingsCommit: `https://github.com/didi-build/foreman-projects/commit/${commit}`,
        platformRun: "https://github.com/didi-build/foreman/actions/runs/9001",
        infraRun: "https://github.com/didi-build/foreman/actions/runs/9002",
        repository: "https://github.com/didi-build/garden-notes",
        bootstrap:
          "https://github.com/didi-build/garden-notes/actions/workflows/bootstrap.yml",
        staging: "https://garden-notes.didi.build",
        health: "https://garden-notes.didi.build/api/health",
      },
      next: [
        'In a few minutes https://garden-notes.didi.build shows the placeholder and https://garden-notes.didi.build/api/health answers {"status":"ok"}. Once Bootstrap and CI finish, it shows the template\'s landing page.',
        "The form does not wait for the Platform and Infra runs: open their links. A run whose plan is not add-only waits for your approval in GitHub, and its summary says why.",
        "Running the form again with the same values shows what is done and does what is not.",
        "The project's own keys, such as its model key, are separate steps (first-hosting runbook, Adding a project).",
      ],
    });
  });

  it("writes the personal-data answer into the file and Bootstrap's input", async () => {
    const f = await setup();
    await f.create({ ...INPUT, collectsPersonalData: false });
    expect(f.settings.creates[0]?.text).toBe(
      projectFileText(entryFor("2026-11-21", { collectsPersonalData: false })),
    );
    expect(f.bootstrap.restartInputs).toEqual([
      { displayName: "Garden Notes", collectsPersonalData: false },
    ]);
  });

  it("writes the standard size read from Foreman's main, whatever it is", async () => {
    const f = await setup();
    f.settings.quota = { ...STANDARD_QUOTA, pods: 20 };
    await f.create();
    expect(f.settings.creates[0]?.text).toContain('"pods": 20');
  });

  it("names the run in the commit message only when it is a UUID", () => {
    expect(settingsCommitMessage(SLUG, RUN_ID)).toBe(
      `Add project garden-notes (New project form, Windmill run ${RUN_ID}, ADR 0118)`,
    );
    for (const runId of [null, undefined, "", "not-a-run\nline", `${RUN_ID}x`])
      expect(settingsCommitMessage(SLUG, runId)).toBe(
        "Add project garden-notes (New project form, ADR 0118)",
      );
  });

  it("gives no secret, token or database id in its result", async () => {
    const f = await setup();
    const shown = JSON.stringify(await f.create());
    expect(shown).not.toMatch(/database_id|uuid|fake-|Bearer/);
    expect(Object.keys(await f.create()).sort()).toEqual([
      "links",
      "message",
      "next",
      "outcome",
      "steps",
    ]);
  });
});

describe("running the form again (unit, ADR 0118 appendix C, O-161)", () => {
  it("finds every piece an earlier run made and makes nothing twice", async () => {
    const f = await setup();
    await f.create();
    f.order.length = 0;
    const again = await f.create();
    expect(again.outcome).toBe("completed");
    expect(again.message).toBe(NEW_PROJECT_MESSAGES.completed);
    expect(outcomes(again)).toEqual([
      "database found",
      "placeholder skipped",
      "settings_file found",
      "workflows started",
      "repository found",
      "record found",
      "bootstrap skipped",
    ]);
    // Only the starts, which are harmless twice, are made again, with the same commit.
    expect(f.order).toEqual(["setUp", "start", "record"]);
    expect(f.workflows.starts).toEqual([`${"c".repeat(39)}1`, `${"c".repeat(39)}1`]);
    expect(f.settings.creates).toHaveLength(1);
    expect(f.repositories.generated).toHaveLength(1);
    expect(await f.store.listProjects()).toHaveLength(1);
    expect(f.bootstrap.calls.filter((c) => !c.startsWith("latestRestart"))).toEqual([
      `grant ${SLUG}`,
      `restart ${SLUG}`,
    ]);
  });

  it("starts Bootstrap again only when its last restart failed, never when it succeeded", async () => {
    const f = await setup();
    await f.create();
    f.bootstrap.finish(SLUG, "success");
    const done = await f.create();
    expect(done.steps.at(-1)).toMatchObject({ step: "bootstrap", outcome: "found" });
    f.bootstrap.runs.get(SLUG)?.push({
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
    });
    const failed = await f.create();
    expect(failed.steps.at(-1)).toMatchObject({
      step: "bootstrap",
      outcome: "started",
    });
    expect(f.bootstrap.calls.filter((c) => c.startsWith("restart"))).toHaveLength(2);
    f.bootstrap.failRunReads = true;
    expect(await f.create()).toMatchObject(refusal("setup_unreadable"));
  });

  type Failure = {
    name: string;
    step: (typeof NEW_PROJECT_STEPS)[number];
    reason: NewProjectRefusal;
    fail: (f: Fixture) => void;
    githubStatus?: number;
    cloudflare?: boolean;
  };
  const failures: Failure[] = [
    {
      name: "Cloudflare refusing the database",
      step: "database",
      reason: "setup_refused",
      cloudflare: true,
      fail: (f) => {
        f.next.setUp = {
          outcome: "refused",
          step: "database",
          reason: "database_credential_refused",
          text: "Cloudflare refused the D1 credential",
          detail: { call: "database_list", status: 403, codes: [10000] },
        };
      },
    },
    {
      name: "Cloudflare refusing the placeholder",
      step: "placeholder",
      reason: "setup_refused",
      cloudflare: true,
      fail: (f) => {
        // The database is made, then the upload is refused.
        const target = f.target.setUp.bind(f.target);
        f.next.beforeSetUp = async () => {
          f.next.beforeSetUp = undefined;
          await target({ slug: SLUG, displayName: "x", purpose: "y" });
          f.target.setUps.pop();
        };
        f.next.setUp = {
          outcome: "refused",
          step: "placeholder",
          database: "created",
          reason: "cloudflare_unavailable",
          text: "Cloudflare failed or limited a step of the project's setup; running it again tries again",
          detail: { call: "worker_upload", status: 503 },
        };
      },
    },
    {
      name: "the settings write token refused",
      step: "settings_file",
      reason: "settings_token_refused",
      fail: (f) => {
        f.settings.nextCreate = { kind: "refused", step: "token" };
      },
    },
    {
      name: "GitHub refusing the settings write",
      step: "settings_file",
      reason: "settings_write_refused",
      githubStatus: 403,
      fail: (f) => {
        f.settings.nextCreate = { kind: "refused", step: "call", status: 403 };
      },
    },
    {
      name: "the settings write failing",
      step: "settings_file",
      reason: "settings_write_refused",
      fail: (f) => {
        f.settings.nextCreate = "throw";
      },
    },
    {
      name: "the start token refused",
      step: "workflows",
      reason: "workflows_token_refused",
      fail: (f) => {
        f.workflows.next = {
          platform: { kind: "refused", step: "token" },
          infra: { kind: "refused", step: "token" },
        };
      },
    },
    {
      name: "GitHub refusing the Infra start",
      step: "workflows",
      reason: "workflows_refused",
      githubStatus: 422,
      fail: (f) => {
        f.workflows.next = { infra: { kind: "refused", step: "call", status: 422 } };
      },
    },
    {
      name: "the starts failing",
      step: "workflows",
      reason: "workflows_refused",
      fail: (f) => {
        f.workflows.next = "throw";
      },
    },
    {
      name: "the creation token refused",
      step: "repository",
      reason: "creation_token_refused",
      fail: (f) => {
        f.repositories.nextGenerate = { kind: "refused", step: "creation_token" };
      },
    },
    {
      name: "GitHub refusing the create",
      step: "repository",
      reason: "create_refused",
      fail: (f) => {
        f.repositories.nextGenerate = { kind: "refused", step: "create" };
      },
    },
    {
      name: "the grant token refused",
      step: "bootstrap",
      reason: "grant_token_refused",
      fail: (f) => {
        f.bootstrap.refuse = { grant: "token" };
      },
    },
    {
      name: "the secret not shared with selected repositories",
      step: "bootstrap",
      reason: "secret_not_selected",
      fail: (f) => {
        f.bootstrap.refuse = { grant: "not_selected" };
      },
    },
    {
      name: "GitHub refusing Bootstrap's start",
      step: "bootstrap",
      reason: "restart_refused",
      githubStatus: 422,
      fail: (f) => {
        f.bootstrap.refuse = { restart: "call" };
        f.bootstrap.restartStatus = 422;
      },
    },
  ];

  it.each(failures.map((failure) => [failure.name, failure] as const))(
    "stops at %s, then a run again does the rest and makes nothing twice",
    async (_name, failure) => {
      const f = await setup();
      failure.fail(f);
      const first = await f.create();
      expect(first).toMatchObject(refusal(failure.reason));
      expect(first.githubStatus).toBe(failure.githubStatus);
      expect(first.cloudflare !== undefined).toBe(failure.cloudflare === true);
      const at = NEW_PROJECT_STEPS.indexOf(failure.step);
      const line = first.steps.find((l) => l.step === failure.step);
      expect(line).toEqual({
        step: failure.step,
        outcome: "refused",
        text: NEW_PROJECT_REFUSALS[failure.reason],
      });
      for (const later of NEW_PROJECT_STEPS.slice(at + 1))
        expect(first.steps.find((l) => l.step === later)).toEqual({
          step: later,
          outcome: "not_reached",
          text: NOT_REACHED_TEXT,
        });
      for (const earlier of NEW_PROJECT_STEPS.slice(0, at))
        expect(["created", "started"] as StepOutcome[], earlier).toContain(
          first.steps.find((l) => l.step === earlier)?.outcome,
        );
      expect(first.next).toEqual([
        "Fix what the message names, then run the form again with the same values: it finds what is done and does the rest.",
      ]);

      // Cleared, the form runs again and completes, with each piece made once.
      f.bootstrap.refuse = {};
      const again = await f.create();
      expect(again.outcome, JSON.stringify(again)).toBe(
        at === 0 ? "created" : "completed",
      );
      expect(again.steps.map((l) => l.outcome)).not.toContain("refused");
      expect(f.target.setUps.filter((s) => !s.dryRun).length).toBeLessThanOrEqual(2);
      expect([...f.settings.files.keys()]).toEqual([SLUG]);
      expect(f.repositories.existing.size).toBe(1);
      expect(
        f.repositories.generated.length - (failure.step === "repository" ? 1 : 0),
      ).toBe(1);
      expect(await f.store.listProjects()).toHaveLength(1);
      expect(f.bootstrap.selected).toEqual(new Set([SLUG]));
      // The file is written once, and each start names its commit.
      const commits = new Set(f.workflows.starts);
      expect(commits).toEqual(new Set([f.settings.files.get(SLUG)?.commit]));
    },
  );

  it("reads a file GitHub did not create, keeping it only when it holds these values", async () => {
    const f = await setup();
    f.settings.files.set(SLUG, {
      text: projectFileText(entryFor()),
      commit: "d".repeat(40),
    });
    // The file appears between the check and the write: the form reads it again.
    const read = f.settings.readFile.bind(f.settings);
    let first = true;
    f.settings.readFile = async (slug) => {
      if (first) {
        first = false;
        return null;
      }
      return read(slug);
    };
    const kept = await f.create();
    expect(kept.outcome).toBe("completed");
    expect(kept.steps[2]).toMatchObject({ step: "settings_file", outcome: "found" });
    expect(f.workflows.starts).toEqual(["d".repeat(40)]);

    const g = await setup();
    g.settings.nextCreate = { kind: "not_created" };
    g.settings.files.set(SLUG, {
      text: projectFileText(entryFor("2026-11-20", { displayName: "Other" })),
      commit: "e".repeat(40),
    });
    const readG = g.settings.readFile.bind(g.settings);
    let firstG = true;
    g.settings.readFile = async (slug) => {
      if (firstG) {
        firstG = false;
        return null;
      }
      return readG(slug);
    };
    const changed = await g.create();
    expect(changed).toMatchObject(refusal("settings_file_changed"));
    expect(g.workflows.starts).toEqual([]);
    expect(g.repositories.generated).toEqual([]);
  });

  it("keeps a file an earlier run wrote on another day, and starts the runs with its commit", async () => {
    const f = await setup();
    f.settings.files.set(SLUG, {
      text: projectFileText(entryFor("2026-11-19")),
      commit: "a".repeat(40),
    });
    const result = await f.create();
    expect(result.outcome).toBe("completed");
    expect(f.settings.creates).toEqual([]);
    expect(f.workflows.starts).toEqual(["a".repeat(40)]);
    expect(result.links.settingsCommit).toBe(
      `https://github.com/didi-build/foreman-projects/commit/${"a".repeat(40)}`,
    );
    // The file is there, so the name may be made already: no DNS lookup.
    expect(f.names.lookups).toEqual([]);
  });

  it("reuses a repository an earlier run created, read before or after the create", async () => {
    const f = await setup();
    f.repositories.existing.set(SLUG, launchpadRepository(SLUG));
    const found = await f.create();
    expect(found.steps[4]).toMatchObject({ step: "repository", outcome: "found" });
    expect(f.repositories.generated).toEqual([]);

    const g = await setup();
    g.repositories.nextGenerate = { kind: "not_created" };
    const read = g.repositories.read.bind(g.repositories);
    let reads = 0;
    g.repositories.read = async (name) => {
      reads += 1;
      if (reads === 1) return null;
      g.repositories.existing.set(SLUG, launchpadRepository(SLUG));
      return read(name);
    };
    const reused = await g.create();
    expect(reused.steps[4]).toMatchObject({ step: "repository", outcome: "found" });
    expect(reused.outcome).toBe("completed");
  });

  it("refuses a create GitHub answers oddly, or a repository it cannot read after a 422", async () => {
    const f = await setup();
    f.repositories.nextGenerate = {
      kind: "created",
      repository: { ...launchpadRepository(SLUG), private: true },
    };
    expect(await f.create()).toMatchObject(refusal("created_unexpected"));
    const g = await setup();
    g.repositories.nextGenerate = { kind: "not_created" };
    expect(await g.create()).toMatchObject(refusal("existing_unreadable"));
    expect(await g.store.listProjects()).toEqual([]);
  });

  it("keeps a row this form recorded", async () => {
    const f = await setup();
    await f.store.insertProject({
      id: "76000000-0000-4000-8000-0000000000aa",
      ...plannedProject(SLUG, "Garden Notes"),
      createdAt: T0,
    });
    const result = await f.create();
    expect(result.steps[5]).toMatchObject({ step: "record", outcome: "found" });
    expect(await f.store.listProjects()).toHaveLength(1);
  });
});

describe("a short name already in use (unit, ADR 0118 appendix C check 3, O-161)", () => {
  const taken: [string, (f: Fixture) => Promise<void> | void, NewProjectRefusal][] = [
    [
      "a file with another display name",
      (f) => {
        f.settings.files.set(SLUG, {
          text: projectFileText(entryFor("2026-11-20", { displayName: "Other" })),
          commit: "a".repeat(40),
        });
      },
      "settings_file_taken",
    ],
    [
      "a file with a bigger size",
      (f) => {
        f.settings.files.set(SLUG, {
          text: projectFileText(
            entryFor("2026-11-20", { quota: { ...STANDARD_QUOTA, pods: 24 } }),
          ),
          commit: "a".repeat(40),
        });
      },
      "settings_file_taken",
    ],
    [
      "a file with the cluster target",
      (f) => {
        f.settings.files.set(SLUG, {
          text: projectFileText(entryFor("2026-11-20", { deployTarget: "cluster" })),
          commit: "a".repeat(40),
        });
      },
      "settings_file_taken",
    ],
    [
      "a file the rules refuse",
      (f) => {
        f.settings.files.set(SLUG, { text: "{}", commit: "a".repeat(40) });
      },
      "settings_file_taken",
    ],
    [
      "a row the register form recorded, named by its slug",
      async (f) => {
        await f.store.insertProject({
          id: "76000000-0000-4000-8000-0000000000bb",
          ...plannedProject(SLUG, SLUG),
          createdAt: T0,
        });
      },
      "record_taken",
    ],
    [
      "a row with another target",
      async (f) => {
        await f.store.insertProject({
          id: "76000000-0000-4000-8000-0000000000bc",
          ...plannedProject(SLUG, "Garden Notes"),
          deployTarget: "cluster",
          createdAt: T0,
        });
      },
      "record_taken",
    ],
    [
      "a repository not from Launchpad",
      (f) => {
        f.repositories.existing.set(SLUG, {
          ...launchpadRepository(SLUG),
          templateFullName: null,
        });
      },
      "existing_not_from_template",
    ],
    [
      "a private repository",
      (f) => {
        f.repositories.existing.set(SLUG, {
          ...launchpadRepository(SLUG),
          private: true,
          visibility: "private",
        });
      },
      "existing_not_public",
    ],
    [
      "a repository under another name",
      (f) => {
        f.repositories.existing.set(SLUG, {
          ...launchpadRepository(SLUG),
          fullName: "didi-build/Garden-Notes",
        });
      },
      "existing_other_name",
    ],
    [
      "a name the zone already answers",
      (f) => {
        f.names.inUseNames.add("garden-notes.didi.build");
      },
      "name_in_use",
    ],
    [
      "a DNS lookup that does not answer",
      (f) => {
        f.names.fail = true;
      },
      "name_unreadable",
    ],
    [
      "Foreman's standard size unreadable",
      (f) => {
        f.settings.quota = "fail";
      },
      "standard_quota_unreadable",
    ],
    [
      "the project file unreadable",
      (f) => {
        f.settings.failReads = true;
      },
      "settings_unreadable",
    ],
    [
      "the repository unreadable",
      (f) => {
        f.repositories.failReads = true;
      },
      "repository_unreadable",
    ],
  ];

  it.each(taken)(
    "refuses %s with fixed text, creating nothing",
    async (_name, take, reason) => {
      for (const live of [true, false]) {
        const f = await setup({ live });
        await take(f);
        const before = await f.store.listProjects();
        expect(await f.create()).toEqual({
          ...refusal(reason),
          steps: [],
          links: {},
          next: [
            "Choose another short name, or run the form again with the values of the earlier run.",
          ],
        });
        expect(f.order).toEqual([]);
        expect(f.settings.creates).toEqual([]);
        expect(f.workflows.starts).toEqual([]);
        expect(f.repositories.generated).toEqual([]);
        expect(f.bootstrap.calls).toEqual([]);
        expect(await f.store.listProjects()).toEqual(before);
      }
    },
  );
});
