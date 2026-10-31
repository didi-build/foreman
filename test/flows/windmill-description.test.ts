// Seam: the flow layer as data and as code (unit: repo guard, build plan M3.1). It keeps
// flows/windmill.yaml in step with the flow files and the composition module, and checks that a
// flow entry holds no rule: it is short, and it never names a contract state, a guard or a
// trigger kind's move, since those live in the contracts and the core (essentials 3 and 7). The
// import side of "no rule" is the lint rule in eslint/layer-boundary.mjs
// (test/import-boundaries.test.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { SECRET_PATHS, VALUE_NAMES } from "../../flows/lib/environment.ts";
import { APPROVAL_CHOICE_LABELS } from "../../src/core/approvals.ts";
import { GUARD_NAMES } from "../../src/core/guards/index.ts";
import { machine2 } from "../reconcile-fixture.ts";

interface Description {
  flows: {
    name: string;
    path: string;
    entry: string;
    trigger: string;
    schedule?: { every_minutes: number; cron: string };
    suspend?: {
      hide_cancel?: boolean;
      resume_form: Record<string, { type: string; required: boolean; enum?: string[] }>;
    };
  }[];
  resources: { secrets: { path: string }[]; values: { name: string }[] };
}

const description = parse(readFileSync("flows/windmill.yaml", "utf8")) as Description;
const entryFiles = readdirSync("flows")
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join("flows", name));

/** The most lines a flow entry needs to compose, check the switches and call one entrypoint. */
const MAX_ENTRY_LINES = 60;

describe("flows/windmill.yaml (unit: repo guard, build plan M3.1)", () => {
  it("lists every flow entry once, each exporting `run` and `main`", async () => {
    expect(description.flows.map((f) => f.entry).sort()).toEqual(
      [...entryFiles].sort(),
    );
    for (const flow of description.flows) {
      expect(flow.path).toBe(`f/foreman/${flow.name}`);
      const url = pathToFileURL(resolve(flow.entry)).href;
      const module = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
      expect(typeof module.run, flow.entry).toBe("function");
      expect(typeof module.main, flow.entry).toBe("function");
    }
  });

  it("schedules only the reconcile flow, at the seeded reconcile_interval_minutes", () => {
    const scheduled = description.flows.filter((f) => f.trigger === "schedule");
    expect(scheduled.map((f) => f.name)).toEqual(["reconcile"]);
    const seed = /\('reconcile_interval_minutes', '(\d+)'/.exec(
      readFileSync("db/migrations/0001_factory_schema.sql", "utf8"),
    );
    const minutes = Number(seed?.[1]);
    expect(minutes).toBe(120);
    expect(scheduled[0]?.schedule).toEqual({
      every_minutes: minutes,
      cron: `0 0 */${minutes / 60} * * *`,
      timezone: "UTC",
    });
  });

  it("offers the approval page's three answers, exactly the labels the core reads (D-200)", () => {
    const approval = description.flows.find((f) => f.name === "approval");
    expect(approval?.suspend?.hide_cancel).toBe(true);
    expect(approval?.suspend?.resume_form.answer).toEqual({
      type: "string",
      required: true,
      enum: Object.keys(APPROVAL_CHOICE_LABELS),
    });
    expect(approval?.suspend?.resume_form.reply).toMatchObject({ type: "string" });
  });

  it("lists exactly the secrets and values the composition module reads", () => {
    expect(description.resources.secrets.map((s) => s.path).sort()).toEqual(
      Object.values(SECRET_PATHS).sort(),
    );
    expect(description.resources.values.map((v) => v.name).sort()).toEqual(
      Object.values(VALUE_NAMES).sort(),
    );
  });
});

describe("a flow entry holds no rule (unit: repo guard, build plan M3.1)", () => {
  const contracts = machine2();
  const names = new Set([...Object.keys(contracts.states), ...GUARD_NAMES]);
  /** Every state or guard a source names in a string literal. */
  const namedRules = (source: string): string[] =>
    [...source.matchAll(/["'`]([^"'`\n]*)["'`]/g)]
      .map((m) => m[1] ?? "")
      .filter((text) => names.has(text));

  it.each(entryFiles)("%s is short and names no state or guard", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source.split("\n").length).toBeLessThanOrEqual(MAX_ENTRY_LINES);
    expect(namedRules(source)).toEqual([]);
  });

  it("the check finds a state or a guard named in a flow", () => {
    expect(
      namedRules(`if (node.state === "in_qa_review" && pass('ci_green_on_head')) {}`),
    ).toEqual(["in_qa_review", "ci_green_on_head"]);
  });
});
