// Seam: unit, Didi's Set project secret form in the core (ADR 0118 appendix D, D-440, O-163), on
// the memory store with a fixed clock and id source, the fake deploy target
// (src/adapters/deploy/fake.ts) and the fake short-lived variable
// (src/adapters/windmill/fake-short-lived-variables.ts). The switches, the exact order of the
// effects (the variable found and deleted, the checks, the put, the record), each check, a run
// whose record cannot be read or whose variable is not deleted, a value box that held no
// reference, a refused put, and what Didi sees. The value is made up and is checked to be in no
// result, refusal, record or log. No network.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFakeClusterTarget,
  createFakeStagingTarget,
} from "../src/adapters/deploy/fake.ts";
import {
  createFakeShortLivedVariables,
  FAKE_SECRET_ARG_PATH,
} from "../src/adapters/windmill/fake-short-lived-variables.ts";
import type { SecretPut } from "../src/core/deploy-target.ts";
import { createMemoryStore } from "../src/core/memory-store.ts";
import {
  createSetProjectSecretForm,
  SET_PROJECT_SECRET_MESSAGES,
  SET_PROJECT_SECRET_RECORDER,
  SET_PROJECT_SECRET_REFUSALS,
  SHORT_LIVED_VARIABLE_TEXTS,
  VALUE_ARGUMENT,
  type SetProjectSecretInput,
  type SetProjectSecretRefusal,
} from "../src/core/set-project-secret.ts";
import type { Json, Project } from "../src/core/store.ts";

const T0 = new Date("2026-11-21T12:00:00Z");
const SLUG = "garden-notes";
const RUN_ID = "0192f0a0-1234-4abc-8def-0123456789ab";
/** Obviously fake: never a real key. */
const VALUE = "test-only-secret-value-do-not-use-0123456789";
const INPUT: SetProjectSecretInput = {
  project: SLUG,
  name: "MODEL_API_KEY",
  value: VALUE,
  runId: RUN_ID,
};

const project = (change: Partial<Project> = {}): Project => ({
  id: "79000000-0000-4000-8000-000000000001",
  slug: SLUG,
  name: "Garden Notes",
  repo: `didi-build/${SLUG}`,
  linearProjectId: null,
  galleryPathOverride: null,
  privilegedPathsExtra: [],
  prodRequiresApproval: true,
  stagingUrl: `https://${SLUG}.didi.build`,
  deployTarget: "cloudflare",
  createdAt: T0,
  ...change,
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup(options: { live?: boolean; project?: Project | null } = {}) {
  const store = createMemoryStore();
  let n = 0;
  const ids = {
    next: () => `79000000-0000-4000-8000-${String(++n + 100).padStart(12, "0")}`,
  };
  const setting = (key: string, value: Json) =>
    store.setSetting({ key, value, updatedBy: "test", updatedAt: T0 });
  await setting("kill_switch", false);
  await setting("dry_run", !(options.live ?? true));
  const registered = options.project === undefined ? project() : options.project;
  if (registered) await store.insertProject(registered);
  const target = createFakeStagingTarget();
  const cluster = createFakeClusterTarget();
  const variables = createFakeShortLivedVariables();
  // Every effect, in the order the form makes it, and every put's arguments.
  const order: string[] = [];
  const puts: [string, string, string][] = [];
  const next: { put: SecretPut | "throw" | null } = { put: null };
  const deps = {
    store: {
      ...store,
      insertProjectSecretName: async (
        record: Parameters<typeof store.insertProjectSecretName>[0],
      ) => {
        order.push(`record ${record.name}`);
        return store.insertProjectSecretName(record);
      },
    },
    clock: { now: () => new Date(T0) },
    ids,
    targets: {
      cloudflare: {
        putSecret: async (slug: string, name: string, value: string) => {
          order.push(`put ${slug} ${name}`);
          puts.push([slug, name, value]);
          const answer = next.put;
          next.put = null;
          if (answer === "throw") throw new Error("the fake target broke");
          return answer ?? target.putSecret(slug, name, value);
        },
      },
      cluster,
    },
    shortLivedVariables: {
      find: async (argument: string) => {
        order.push(`find ${argument}`);
        return variables.find(argument);
      },
      remove: async (path: string) => {
        order.push(`remove ${path}`);
        return variables.remove(path);
      },
    },
  };
  const form = createSetProjectSecretForm(deps);
  return {
    store,
    setting,
    target,
    cluster,
    variables,
    order,
    puts,
    next,
    form,
    deps,
    records: () => store.listProjectSecretNames(project().id),
  };
}

/** The value must reach nothing but the one put. */
async function expectValueNowhere(
  t: Awaited<ReturnType<typeof setup>>,
  result: unknown,
): Promise<void> {
  expect(JSON.stringify(result)).not.toContain(VALUE);
  expect(JSON.stringify(await t.records())).not.toContain(VALUE);
  expect(
    JSON.stringify([...t.target.secretNames.entries()].map(([k, v]) => [k, [...v]])),
  ).not.toContain(VALUE);
  expect(t.variables.calls.join(" ")).not.toContain(VALUE);
  expect(t.order.join(" ")).not.toContain(VALUE);
}

function watchConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((name) =>
    vi.spyOn(console, name).mockImplementation(() => undefined),
  );
}

describe("the Set project secret form (unit: ADR 0118 appendix D, D-440, O-163)", () => {
  it("deletes the short-lived variable, then puts the value on the staging Worker, then records the name and the time, and answers with the project and the name only", async () => {
    const consoleCalls = watchConsole();
    const t = await setup();
    const result = await t.form.set(INPUT);
    expect(t.order).toEqual([
      `find ${VALUE_ARGUMENT}`,
      `remove ${FAKE_SECRET_ARG_PATH}`,
      `put ${SLUG} MODEL_API_KEY`,
      "record MODEL_API_KEY",
    ]);
    expect(t.puts).toEqual([[SLUG, "MODEL_API_KEY", VALUE]]);
    expect(result).toEqual({
      outcome: "set",
      message: SET_PROJECT_SECRET_MESSAGES.set,
      project: SLUG,
      name: "MODEL_API_KEY",
      shortLivedVariable: { step: "deleted", text: SHORT_LIVED_VARIABLE_TEXTS.deleted },
      next: [
        `Every later staging deploy of ${SLUG} keeps MODEL_API_KEY on the Worker. A deploy held because MODEL_API_KEY was missing (D-448) goes through on the reconcile pass's next run.`,
        "To change the value, run the form again with the same name: the new value replaces the old one.",
      ],
    });
    expect(await t.records()).toEqual([
      {
        id: "79000000-0000-4000-8000-000000000101",
        projectId: project().id,
        name: "MODEL_API_KEY",
        setAt: T0,
        windmillRunId: RUN_ID,
        recordedBy: SET_PROJECT_SECRET_RECORDER,
      },
    ]);
    expect([...(t.target.secretNames.get(SLUG) ?? [])]).toEqual(["MODEL_API_KEY"]);
    await expectValueNowhere(t, result);
    for (const spy of consoleCalls) expect(spy).not.toHaveBeenCalled();
  });

  it("records each set, the same name again included, and the run only when its id is a UUID", async () => {
    const t = await setup();
    await t.form.set(INPUT);
    await t.form.set({ ...INPUT, runId: "not-a-uuid" });
    await t.form.set({ ...INPUT, runId: null });
    expect((await t.records()).map((r) => [r.name, r.windmillRunId])).toEqual([
      ["MODEL_API_KEY", RUN_ID],
      ["MODEL_API_KEY", null],
      ["MODEL_API_KEY", null],
    ]);
  });

  it("under the kill switch reads, deletes, sets and records nothing, and says the variable expires on its own", async () => {
    const t = await setup();
    await t.setting("kill_switch", true);
    const result = await t.form.set(INPUT);
    expect(result).toEqual({
      outcome: "refused",
      reason: "kill_switch",
      message: SET_PROJECT_SECRET_REFUSALS.kill_switch,
      shortLivedVariable: {
        step: "not_reached",
        text: SHORT_LIVED_VARIABLE_TEXTS.not_reached,
      },
      next: [],
    });
    expect(t.order).toEqual([]);
    expect(await t.records()).toEqual([]);
    await expectValueNowhere(t, result);
  });

  it("in dry run checks and deletes the variable, and sets and records nothing", async () => {
    const t = await setup({ live: false });
    const result = await t.form.set(INPUT);
    expect(result).toEqual({
      outcome: "dry_run",
      message: SET_PROJECT_SECRET_MESSAGES.dry_run,
      project: SLUG,
      name: "MODEL_API_KEY",
      shortLivedVariable: { step: "deleted", text: SHORT_LIVED_VARIABLE_TEXTS.deleted },
      next: [
        `Turn dry run off and run the form again to put MODEL_API_KEY on ${SLUG}-staging: the password field takes the value again.`,
      ],
    });
    expect(t.order).toEqual([
      `find ${VALUE_ARGUMENT}`,
      `remove ${FAKE_SECRET_ARG_PATH}`,
    ]);
    expect(await t.records()).toEqual([]);
    // Dry run still refuses what the checks refuse.
    expect((await t.form.set({ ...INPUT, name: "DB" })).reason).toBe("invalid_name");
    await expectValueNowhere(t, result);
  });

  it("refuses before any check when the value box held no reference to a short-lived variable, deleting and setting nothing", async () => {
    const t = await setup();
    t.variables.found = { kind: "not_a_reference" };
    const result = await t.form.set(INPUT);
    expect(result).toEqual({
      outcome: "refused",
      reason: "not_a_reference",
      message: SET_PROJECT_SECRET_REFUSALS.not_a_reference,
      shortLivedVariable: { step: "none", text: SHORT_LIVED_VARIABLE_TEXTS.none },
      next: [],
    });
    expect(t.order).toEqual([`find ${VALUE_ARGUMENT}`]);
    expect(await t.records()).toEqual([]);
    await expectValueNowhere(t, result);
    // An empty box holds no reference either: the value's check names it.
    const empty = await t.form.set({ ...INPUT, value: "" });
    expect(empty).toMatchObject({
      reason: "invalid_value",
      shortLivedVariable: { step: "none" },
    });
  });

  it("still sets the secret when the run's record cannot be read or the variable is not deleted, and says it expires on its own", async () => {
    const cases: [
      Awaited<ReturnType<typeof setup>>["variables"]["found"],
      Awaited<ReturnType<typeof setup>>["variables"]["removal"],
      object,
    ][] = [
      [{ kind: "unreadable" }, { removed: true }, { step: "unread" }],
      [
        { kind: "unreadable", status: 403 },
        { removed: true },
        { step: "unread", windmillStatus: 403 },
      ],
      ["throw", { removed: true }, { step: "unread" }],
      [
        { kind: "variable", path: FAKE_SECRET_ARG_PATH },
        { removed: false, status: 404 },
        { step: "not_deleted", windmillStatus: 404 },
      ],
      [
        { kind: "variable", path: FAKE_SECRET_ARG_PATH },
        { removed: false },
        { step: "not_deleted" },
      ],
      [
        { kind: "variable", path: FAKE_SECRET_ARG_PATH },
        "throw",
        { step: "not_deleted" },
      ],
    ];
    for (const [found, removal, variable] of cases) {
      const t = await setup();
      t.variables.found = found;
      t.variables.removal = removal;
      const result = await t.form.set(INPUT);
      expect(result.outcome, JSON.stringify(variable)).toBe("set");
      expect(result.shortLivedVariable).toEqual({
        ...variable,
        text: SHORT_LIVED_VARIABLE_TEXTS[(variable as { step: "unread" }).step],
      });
      expect(result.shortLivedVariable.text).toContain(
        "expires on its own 7 days after it was made",
      );
      expect(await t.records()).toHaveLength(1);
      await expectValueNowhere(t, result);
    }
  });

  it("refuses a project, name or value outside its rule after deleting the variable, sets nothing, and shows a box only once it passed", async () => {
    const cases: [Partial<SetProjectSecretInput>, SetProjectSecretRefusal, object][] = [
      [{ project: "Garden" }, "invalid_project", {}],
      [{ project: "" }, "invalid_project", {}],
      [{ project: "garden notes" }, "invalid_project", {}],
      [{ project: 7 as unknown as string }, "invalid_project", {}],
      [{ name: "model_api_key" }, "invalid_name", { project: SLUG }],
      [{ name: "1KEY" }, "invalid_name", { project: SLUG }],
      [{ name: "_KEY" }, "invalid_name", { project: SLUG }],
      [{ name: "MODEL-KEY" }, "invalid_name", { project: SLUG }],
      [{ name: "" }, "invalid_name", { project: SLUG }],
      [{ name: `K${"E".repeat(64)}` }, "invalid_name", { project: SLUG }],
      [{ name: "DB" }, "invalid_name", { project: SLUG }],
      [{ name: "ASSETS" }, "invalid_name", { project: SLUG }],
      // A value pasted into the name box is never shown back.
      [{ name: VALUE }, "invalid_name", { project: SLUG }],
      [
        { value: "x".repeat(5 * 1024 + 1) },
        "invalid_value",
        { project: SLUG, name: "MODEL_API_KEY" },
      ],
      [
        { value: "é".repeat(2561) },
        "invalid_value",
        { project: SLUG, name: "MODEL_API_KEY" },
      ],
    ];
    for (const [change, reason, shown] of cases) {
      const t = await setup();
      const result = await t.form.set({ ...INPUT, ...change });
      expect(result, reason).toEqual({
        outcome: "refused",
        reason,
        message: SET_PROJECT_SECRET_REFUSALS[reason],
        ...shown,
        shortLivedVariable: {
          step: "deleted",
          text: SHORT_LIVED_VARIABLE_TEXTS.deleted,
        },
        next: ["Fix what the message names, then run the form again with the value."],
      });
      expect(t.order, reason).toEqual([
        `find ${VALUE_ARGUMENT}`,
        `remove ${FAKE_SECRET_ARG_PATH}`,
      ]);
      expect(await t.records()).toEqual([]);
      await expectValueNowhere(t, result);
    }
  });

  it("takes a name of 64 characters and a value of exactly 5 KiB", async () => {
    const t = await setup();
    const name = `K${"E".repeat(63)}`;
    const value = "é".repeat(2560);
    expect(await t.form.set({ ...INPUT, name, value })).toMatchObject({
      outcome: "set",
      name,
    });
    expect(t.puts).toEqual([[SLUG, name, value]]);
  });

  it("refuses a project the store does not have, or one whose target is not Cloudflare", async () => {
    for (const [registered, reason] of [
      [null, "not_a_project"],
      [project({ deployTarget: "cluster" }), "not_cloudflare"],
    ] as const) {
      const t = await setup({ project: registered });
      const result = await t.form.set(INPUT);
      expect(result).toMatchObject({
        outcome: "refused",
        reason,
        message: SET_PROJECT_SECRET_REFUSALS[reason],
        project: SLUG,
        name: "MODEL_API_KEY",
        shortLivedVariable: { step: "deleted" },
      });
      expect(t.puts).toEqual([]);
      // Routed by the row, the cluster target would refuse too; the form never asks it (O-166).
      expect(t.cluster.refusedCalls).toEqual([]);
      await expectValueNowhere(t, result);
    }
  });

  it("stops before the put when a switch is turned on during the run", async () => {
    for (const key of ["kill_switch", "dry_run"]) {
      const t = await setup();
      const remove = t.deps.shortLivedVariables.remove;
      t.deps.shortLivedVariables.remove = async (path: string) => {
        const done = await remove(path);
        // After the dry run check would read it, so only the second read sees it.
        if (key === "kill_switch") await t.setting("kill_switch", true);
        return done;
      };
      const form = createSetProjectSecretForm({
        ...t.deps,
        store: {
          ...t.deps.store,
          getSetting: async (k: string) => {
            const setting = await t.store.getSetting(k);
            // dry_run turns on once read for step 4.
            if (key === "dry_run" && k === "dry_run" && setting?.value === false) {
              await t.setting("dry_run", true);
            }
            return setting;
          },
        },
      });
      const result = await form.set(INPUT);
      expect(result, key).toMatchObject({
        outcome: "refused",
        reason: "switch_turned_on",
        shortLivedVariable: { step: "deleted" },
      });
      expect(t.puts, key).toEqual([]);
      expect(await t.records()).toEqual([]);
    }
  });

  it("refuses a put the target refuses or fails, with its fixed reason and Cloudflare's call, and records nothing", async () => {
    const cases: [SecretPut | "throw", object][] = [
      [
        {
          outcome: "refused",
          reason: "credential_unavailable",
          text: "the staging deploy credential is not available",
        },
        {
          target: {
            reason: "credential_unavailable",
            text: "the staging deploy credential is not available",
          },
        },
      ],
      [
        {
          outcome: "refused",
          reason: "cloudflare_refused",
          text: "Cloudflare refused the call on the staging Worker's secrets",
          detail: { call: "secret_put", status: 404, codes: [10007] },
        },
        {
          target: {
            reason: "cloudflare_refused",
            text: "Cloudflare refused the call on the staging Worker's secrets",
          },
          cloudflare: { call: "secret_put", status: 404, codes: [10007] },
        },
      ],
      [
        "throw",
        {
          target: {
            reason: "target_error",
            text: "the deploy target failed without saying why",
          },
        },
      ],
    ];
    for (const [answer, extra] of cases) {
      const t = await setup();
      t.next.put = answer;
      const result = await t.form.set(INPUT);
      expect(result).toEqual({
        outcome: "refused",
        reason: "put_refused",
        message: SET_PROJECT_SECRET_REFUSALS.put_refused,
        project: SLUG,
        name: "MODEL_API_KEY",
        ...extra,
        shortLivedVariable: {
          step: "deleted",
          text: SHORT_LIVED_VARIABLE_TEXTS.deleted,
        },
        next: ["Fix what the message names, then run the form again with the value."],
      });
      expect(await t.records()).toEqual([]);
      await expectValueNowhere(t, result);
    }
  });

  it("the memory store keeps migration 0030's rules: a registered project and the form's names only", async () => {
    const t = await setup();
    const record = (change: object) =>
      t.store.insertProjectSecretName({
        id: "79000000-0000-4000-8000-000000000999",
        projectId: project().id,
        name: "MODEL_API_KEY",
        setAt: T0,
        windmillRunId: null,
        recordedBy: SET_PROJECT_SECRET_RECORDER,
        ...change,
      });
    await expect(
      record({ projectId: "79000000-0000-4000-8000-0000000000ff" }),
    ).rejects.toThrow("project_secret_names.project_id must name a project");
    for (const name of ["DB", "ASSETS", "model_api_key", ""]) {
      await expect(record({ name }), name).rejects.toThrow(
        "project_secret_names.name must be a product secret's name",
      );
    }
    await record({});
    await expect(record({})).rejects.toThrow("project_secret_names_pkey");
  });

  it("keeps every fixed text free of a placeholder for the input", () => {
    for (const text of [
      ...Object.values(SET_PROJECT_SECRET_REFUSALS),
      ...Object.values(SET_PROJECT_SECRET_MESSAGES),
      ...Object.values(SHORT_LIVED_VARIABLE_TEXTS),
    ]) {
      expect(text).not.toMatch(/\$\{|<value>|<name>/);
    }
  });
});
