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
import { HOLD_RELEASE_REQUEST_FLOW_PATH } from "../../flows/lib/held-items.ts";
import { SCAN_FLOW_PATH } from "../../flows/lib/scan.ts";
import { PLANNING_TOKEN_SHA256_PATH } from "../../src/api/auth.ts";
import { runScope } from "../../src/adapters/windmill/client.ts";
import {
  PLAN_APPROVAL_FLOW_PATH,
  WINDMILL_PLAN_APPROVAL_TOKEN_PATH,
} from "../../src/adapters/windmill/plan-approval-flow.ts";
import {
  OPTION_CAPTURE_FLOW_PATH,
  RECEIVER_FLOW_PATHS,
  RECEIVER_WINDMILL_TOKEN_PATH,
} from "../../src/adapters/windmill/receiver-flows.ts";
import {
  RECORD_RUN_END_FLOW_PATH,
  RUN_WATCHER_FLOW_PATHS,
  RUN_WATCHER_WINDMILL_TOKEN_PATH,
} from "../../src/adapters/windmill/run-watcher-flows.ts";
import { APPROVAL_CHOICE_LABELS } from "../../src/core/approvals.ts";
import { GUARD_NAMES } from "../../src/core/guards/index.ts";
import { machine2 } from "../reconcile-fixture.ts";

interface Description {
  flows: {
    name: string;
    path: string;
    entry: string;
    trigger: string;
    schedule?: { every_minutes: number; cron: string; timezone: string };
    suspend?: {
      hide_cancel?: boolean;
      resume_form: Record<
        string,
        {
          type: string;
          required: boolean;
          enum?: string[];
          items?: unknown;
        }
      >;
    };
  }[];
  resources: {
    secrets: { path: string; read_by?: string }[];
    values: { name: string }[];
  };
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

  it("schedules only the reconcile flow, at the seeded reconcile_interval_minutes, the scan and the daily check", () => {
    const scheduled = description.flows.filter((f) => f.trigger === "schedule");
    expect(scheduled.map((f) => f.name)).toEqual(["reconcile", "scan", "daily_check"]);
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

  it("is one form: a decision of the three labels the core reads, the request's options, feedback (D-254) and the optional size call (D-278)", () => {
    const approval = description.flows.find((f) => f.name === "approval");
    expect(approval?.suspend?.hide_cancel).toBe(true);
    const form = approval?.suspend?.resume_form ?? {};
    expect(Object.keys(form)).toEqual([
      "decision",
      "options",
      "feedback",
      "small_tweak",
    ]);
    // D-278: Didi's optional size call, a choice so that skipping it is not read as "No".
    expect(form.small_tweak).toEqual({
      type: "string",
      required: false,
      enum: ["Yes, a small tweak", "No, not a small tweak"],
    });
    expect(form.decision).toEqual({
      type: "string",
      required: true,
      enum: Object.keys(APPROVAL_CHOICE_LABELS),
    });
    // A multi-select whose choices are filled per request, never fixed in the file.
    expect(form.options).toEqual({
      type: "array",
      required: false,
      items: { type: "string", enum: [] },
    });
    expect(form.feedback).toEqual({ type: "string", required: false });
  });

  it("lists exactly the secrets and values the composition module reads", () => {
    const forFlows = description.resources.secrets.filter((s) => !s.read_by);
    expect(forFlows.map((s) => s.path).sort()).toEqual(
      Object.values(SECRET_PATHS).sort(),
    );
    // The secrets a service other than the flows reads: the planning chat's token hash (D-266)
    // and the state API's Windmill credential for the plan-approval flow (D-273), both read by
    // the state API, the GitHub receiver's Windmill token (D-291) and the run watcher's (D-330).
    expect(description.resources.secrets.filter((s) => s.read_by)).toEqual([
      expect.objectContaining({
        path: PLANNING_TOKEN_SHA256_PATH,
        read_by: "state API",
      }),
      expect.objectContaining({
        path: WINDMILL_PLAN_APPROVAL_TOKEN_PATH,
        read_by: "state API",
      }),
      expect.objectContaining({
        path: RECEIVER_WINDMILL_TOKEN_PATH,
        read_by: "GitHub receiver",
      }),
      expect.objectContaining({
        path: RUN_WATCHER_WINDMILL_TOKEN_PATH,
        read_by: "run watcher",
      }),
    ]);
    expect(description.resources.values.map((v) => v.name).sort()).toEqual(
      Object.values(VALUE_NAMES).sort(),
    );
  });
});

describe("the plan-approval flow (unit: repo guard, D-273)", () => {
  it("is a called flow at the path the state API's port starts", () => {
    const flow = description.flows.find((f) => f.name === "plan_approval");
    expect(flow?.path).toBe(PLAN_APPROVAL_FLOW_PATH);
    expect(flow?.trigger).toBe("called");
    expect(flow?.entry).toBe("flows/plan-approval.ts");
  });
});

describe("the flow the run watcher starts (unit: repo guard, D-330, O-102)", () => {
  it("is the called run-end flow, at the path the watcher's port starts, and nothing else", () => {
    expect(RUN_WATCHER_FLOW_PATHS).toEqual([RECORD_RUN_END_FLOW_PATH]);
    const flow = description.flows.find((f) => f.path === RECORD_RUN_END_FLOW_PATH);
    expect(flow?.name).toBe("record_run_end");
    expect(flow?.trigger).toBe("called");
    expect(flow?.entry).toBe("flows/record-run-end.ts");
  });
});

describe("the flows the GitHub receiver starts (unit: repo guard, D-291, O-101)", () => {
  it("are called flows, option capture among them, at the paths the receiver's port starts", () => {
    expect(RECEIVER_FLOW_PATHS).toContain(OPTION_CAPTURE_FLOW_PATH);
    for (const path of RECEIVER_FLOW_PATHS) {
      const flow = description.flows.find((f) => f.path === path);
      expect(flow?.trigger, path).toBe("called");
    }
    expect(description.flows.find((f) => f.name === "option_capture")?.entry).toBe(
      "flows/option-capture.ts",
    );
  });

  it("the first-hosting runbook creates each token with exactly its flows' run scopes", () => {
    const runbook = readFileSync("docs/runbooks/first-hosting.md", "utf8");
    const scopes = (text: string) =>
      [...text.matchAll(/`(jobs:run:scripts:[^`]+)`/g)].map((m) => m[1]);
    // One line per token: each names its secret path and its scopes, and nothing more.
    const lineFor = (path: string) =>
      runbook
        .split("\n")
        .find((line) => line.includes(path) && line.includes("jobs:run:"));
    expect(scopes(lineFor(WINDMILL_PLAN_APPROVAL_TOKEN_PATH) ?? "")).toEqual([
      runScope(PLAN_APPROVAL_FLOW_PATH),
    ]);
    expect(scopes(lineFor(RECEIVER_WINDMILL_TOKEN_PATH) ?? "")).toEqual(
      RECEIVER_FLOW_PATHS.map(runScope),
    );
    expect(scopes(lineFor(RUN_WATCHER_WINDMILL_TOKEN_PATH) ?? "")).toEqual(
      RUN_WATCHER_FLOW_PATHS.map(runScope),
    );
  });
});

describe("the daily check flow (unit: repo guard, M4.4, O-91)", () => {
  it("runs once a day, so it stays within the free plan's run budget (D-164)", () => {
    const flow = description.flows.find((f) => f.name === "daily_check");
    expect(flow?.path).toBe("f/foreman/daily_check");
    expect(flow?.entry).toBe("flows/daily-check.ts");
    expect(flow?.trigger).toBe("schedule");
    expect(flow?.schedule).toEqual({
      every_minutes: 24 * 60,
      cron: "0 0 6 * * *",
      // Didi's own morning, daylight saving included (D-297).
      timezone: "America/Toronto",
    });
    // Reconcile every 2 hours (about 360 runs in a 30-day month) plus one daily check (30) and
    // one daily scan (30, O-92) leaves most of the 1,000 for event-triggered runs and the
    // nightly backup (D-164).
    const monthly = description.flows
      .filter((f) => f.schedule)
      .reduce((sum, f) => sum + (30 * 24 * 60) / (f.schedule?.every_minutes ?? 1), 0);
    expect(monthly).toBe(360 + 30 + 30);
  });
});

describe("the scan flow (unit: repo guard, D-299, D-300, O-92)", () => {
  it("runs once a day in Didi's time zone, an hour before the daily check", () => {
    const flow = description.flows.find((f) => f.name === "scan");
    expect(flow?.path).toBe(SCAN_FLOW_PATH);
    expect(flow?.entry).toBe("flows/scan.ts");
    expect(flow?.trigger).toBe("schedule");
    expect(flow?.schedule).toEqual({
      every_minutes: 24 * 60,
      cron: "0 0 5 * * *",
      timezone: "America/Toronto",
    });
    const check = description.flows.find((f) => f.name === "daily_check");
    const hour = (cron: string | undefined) => Number(cron?.split(" ")[2]);
    expect(check?.schedule).toMatchObject({ timezone: "America/Toronto" });
    expect(hour(flow?.schedule?.cron)).toBeLessThan(hour(check?.schedule?.cron));
  });
});

describe("the fresh release request flow (unit: repo guard, D-272)", () => {
  it("is a called flow at the path each held-items entry names, never on a schedule", () => {
    const flow = description.flows.find((f) => f.name === "hold_release_request");
    expect(flow?.path).toBe(HOLD_RELEASE_REQUEST_FLOW_PATH);
    expect(flow?.trigger).toBe("called");
    expect(flow?.entry).toBe("flows/hold-release-request.ts");
    expect(flow?.schedule).toBeUndefined();
  });
});

describe("Didi's cancel flow (unit: repo guard, D-308, O-97)", () => {
  it("is a called flow, never on a schedule", () => {
    const flow = description.flows.find((f) => f.name === "cancel_item");
    expect(flow?.path).toBe("f/foreman/cancel_item");
    expect(flow?.trigger).toBe("called");
    expect(flow?.entry).toBe("flows/cancel-item.ts");
    expect(flow?.schedule).toBeUndefined();
  });
});

describe("a flow entry holds no rule (unit: repo guard, build plan M3.1)", () => {
  const contracts = machine2();
  const names = new Set([...Object.keys(contracts.states), ...GUARD_NAMES]);
  /**
   * Every state or guard a source names in a string literal. A flow result's `outcome` is not a
   * state: the cancel-runs flow's `outcome: "cancelled"` shares its word with the Cancelled state
   * (D-305).
   */
  const namedRules = (source: string): string[] =>
    [...source.matchAll(/(?<!outcome: )["'`]([^"'`\n]*)["'`]/g)]
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
