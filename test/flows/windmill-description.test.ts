// Seam: the flow layer as data and as code (unit: repo guard, build plan M3.1). It keeps
// flows/windmill.yaml in step with the flow files and the composition module, and checks that a
// flow entry holds no rule: it is short, and it never names a contract state, a guard or a
// trigger kind's move, since those live in the contracts and the core (essentials 3 and 7). The
// import side of "no rule" is the lint rule in eslint/layer-boundary.mjs
// (test/import-boundaries.test.ts).
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { SECRET_PATHS, VALUE_NAMES } from "../../flows/lib/environment.ts";
import {
  READ_USAGE_SCOPE,
  READ_VARIABLES_SCOPE,
  WINDMILL_FOLDER,
  windmillVariablePath,
} from "../../flows/lib/windmill.ts";
import { PLATFORM_SECRETS } from "../../infra/kubernetes/platform.ts";
import { HOLD_RELEASE_REQUEST_FLOW_PATH } from "../../flows/lib/held-items.ts";
import { SCAN_FLOW_PATH } from "../../flows/lib/scan.ts";
import { PLANNING_TOKEN_SHA256_PATH } from "../../src/api/auth.ts";
import {
  MACHINE_1_DIR,
  MACHINE_2_DIR,
  TASK_TYPES_FILE,
} from "../../src/adapters/contracts-file/load.ts";
import { BOT_FILES_DIR } from "../../src/adapters/contracts-file/bot-files.ts";
import { SUPABASE_CA_PATH } from "../../src/adapters/store-postgres/tls.ts";
import { runScope } from "../../src/adapters/windmill/client.ts";
import {
  PLAN_APPROVAL_FLOW_PATH,
  WINDMILL_PLAN_APPROVAL_TOKEN_PATH,
} from "../../src/adapters/windmill/plan-approval-flow.ts";
import {
  ADVANCE_ITEM_FLOW_PATH,
  DEPLOY_STAGING_FLOW_PATH,
  OPTION_CAPTURE_FLOW_PATH,
  RECEIVER_FLOW_PATHS,
  RECEIVER_WINDMILL_TOKEN_PATH,
  REMOVE_BOOTSTRAP_ACCESS_FLOW_PATH,
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
  workspace_folder: string;
  bundle_files: string[];
  flows: {
    name: string;
    path: string;
    entry: string;
    trigger: string;
    job_token_scopes: string[];
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
    secrets: { path: string; read_by?: string; windmill_path?: string }[];
    values: { name: string; windmill_path?: string }[];
    windmill_token?: unknown;
    github_apps: {
      secrets: { path: string; windmill_path?: string; written_by?: string }[];
      values: { name: string; windmill_path?: string; written_by?: string }[];
    };
  };
}

const description = parse(readFileSync("flows/windmill.yaml", "utf8")) as Description;
const entryFiles = readdirSync("flows")
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join("flows", name));

/**
 * The most lines a flow entry needs to compose, check the switches and call one entrypoint: 60,
 * and one more for the closing brace of the `main` declaration Windmill reads (O-121).
 */
const MAX_ENTRY_LINES = 61;

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

  it("bundles every repository file the flows read when they run, the database CA certificate included (O-117)", () => {
    const carried = (path: string) =>
      description.bundle_files.some((entry) =>
        entry.endsWith("/") ? path.startsWith(entry) : path === entry,
      );
    for (const path of [MACHINE_1_DIR, MACHINE_2_DIR, TASK_TYPES_FILE, BOT_FILES_DIR]) {
      expect(carried(path), path).toBe(true);
    }
    expect(carried(SUPABASE_CA_PATH)).toBe(true);
    for (const entry of description.bundle_files)
      expect(existsSync(entry), entry).toBe(true);
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
    expect(description.resources.secrets.map((s) => s.path).sort()).toEqual(
      Object.values(SECRET_PATHS).sort(),
    );
    expect(description.resources.values.map((v) => v.name).sort()).toEqual(
      Object.values(VALUE_NAMES).sort(),
    );
  });

  it("keeps no Windmill copy of a secret only a service reads (D-351)", () => {
    expect(description.resources.secrets.filter((s) => s.read_by)).toEqual([]);
    const listed = JSON.stringify(description.resources);
    for (const path of [
      PLANNING_TOKEN_SHA256_PATH,
      WINDMILL_PLAN_APPROVAL_TOKEN_PATH,
      RECEIVER_WINDMILL_TOKEN_PATH,
      RUN_WATCHER_WINDMILL_TOKEN_PATH,
    ]) {
      expect(listed, path).not.toContain(path);
    }
  });

  it("gives a Windmill path, in the flows' folder, only to the three values the runner-token job writes and the three Didi stores for the database login and the staging deploy (D-352, D-370, O-110, O-116)", () => {
    const withPath = [
      ...description.resources.secrets.map((s) => [s.path, s.windmill_path]),
      ...description.resources.values.map((v) => [v.name, v.windmill_path]),
    ].filter(([, windmillPath]) => windmillPath !== undefined);
    expect(Object.fromEntries(withPath)).toEqual({
      [SECRET_PATHS.database]: `f/foreman/${SECRET_PATHS.database}`,
      [SECRET_PATHS.clusterToken]: `f/foreman/${SECRET_PATHS.clusterToken}`,
      [VALUE_NAMES.clusterEndpoint]: `f/foreman/${VALUE_NAMES.clusterEndpoint}`,
      [VALUE_NAMES.clusterCaCertificate]: `f/foreman/${VALUE_NAMES.clusterCaCertificate}`,
      [SECRET_PATHS.stagingDeployToken]: `f/foreman/${SECRET_PATHS.stagingDeployToken}`,
      [SECRET_PATHS.cloudflareAccountId]: `f/foreman/${SECRET_PATHS.cloudflareAccountId}`,
    });
  });

  it("names the staging deploy token's one permission and where Didi puts it (D-353, O-116)", () => {
    const token = description.resources.secrets.find(
      (s) => s.path === SECRET_PATHS.stagingDeployToken,
    ) as { holds?: string; written_by?: string } | undefined;
    expect(token?.holds).toMatch(/Workers Scripts Edit on the account only/);
    expect(token?.written_by).toMatch(/runbook step 16/);
    const runbook = readFileSync("docs/runbooks/first-hosting.md", "utf8");
    expect(runbook).toContain("## 16. The staging deploy token (new-credentials gate)");
    expect(runbook).toContain(`\`f/foreman/${SECRET_PATHS.stagingDeployToken}\``);
    expect(runbook).toContain(`\`f/foreman/${SECRET_PATHS.cloudflareAccountId}\``);
  });

  it("lists every secret as a secret variable and every value as a plain variable, never a resource (D-370)", () => {
    const yaml = readFileSync("flows/windmill.yaml", "utf8");
    expect(yaml).toContain(
      "Every secret here is a Windmill secret variable, which Windmill encrypts with the workspace's",
    );
    expect(yaml).not.toMatch(/foreman_text|"content"|resource type/);
    const runbook = readFileSync("docs/runbooks/first-hosting.md", "utf8");
    const step = (n: string) =>
      runbook.slice(
        runbook.indexOf(`## ${n}. `),
        runbook.indexOf("\n## ", runbook.indexOf(`## ${n}. `) + 1),
      );
    // The database login (step 15) and the staging pair (step 16) are secret variables there.
    expect(step("15")).toContain(
      `stored in Windmill as a secret variable at \`f/foreman/${SECRET_PATHS.database}\``,
    );
    expect(step("16")).toContain(
      "add two secret variables, each holding the value itself",
    );
    // ("resource" is left only in Cloudflare's own form: resource Workers Scripts.)
    expect(step("16")).not.toMatch(
      /foreman_text|"content"|two resources|both resources/,
    );
  });

  it("names the GitHub Apps' keys as secret variables and their ids as plain variables beside them, read by no flow yet (D-368, D-370)", () => {
    const roles = ["runner", "developer", "designer", "qa"];
    const apps = description.resources.github_apps;
    expect(apps.secrets.map((s) => [s.path, s.windmill_path])).toEqual(
      roles.map((role) => [
        `platform/github/${role}-app-private-key`,
        `f/foreman/platform/github/${role}-app-private-key`,
      ]),
    );
    expect(apps.values.map((v) => [v.name, v.windmill_path])).toEqual([
      ...roles.map((role) => [
        `platform/github/${role}-app-id`,
        `f/foreman/platform/github/${role}-app-id`,
      ]),
      [
        "platform/github/runner-app-installation-id",
        "f/foreman/platform/github/runner-app-installation-id",
      ],
    ]);
    for (const entry of [...apps.secrets, ...apps.values])
      expect(entry.written_by).toBe("Didi, by hand (first-hosting runbook step 15)");
    // Not read by the composition yet, so neither a secret path nor a value name of it.
    const read = [
      ...Object.values(SECRET_PATHS),
      ...Object.values(VALUE_NAMES),
    ] as string[];
    for (const entry of apps.secrets) expect(read).not.toContain(entry.path);
    for (const entry of apps.values) expect(read).not.toContain(entry.name);
    // Step 15 names each path: the keys as secret variables, the ids beside them as plain ones.
    const runbook = readFileSync("docs/runbooks/first-hosting.md", "utf8");
    const line = runbook
      .split("\n")
      .find((l) =>
        l.startsWith("- The four GitHub Apps' private keys and ids (D-368, D-370)"),
      );
    for (const entry of [...apps.secrets, ...apps.values])
      expect(line, entry.windmill_path).toContain(`\`${entry.windmill_path ?? ""}\``);
    expect(line).toMatch(/paste the PEM into its Windmill secret variable/);
    expect(line).toMatch(/as plain variables, since they are not secret/);
  });
});

describe("each entry's main, as Windmill reads it (unit: repo guard, O-121)", () => {
  // Windmill reads a script's arguments only from a `main` function declaration (its source,
  // version 1.865.0, windmill-parser-ts): `export const main = (input) => ...` gets none, so
  // `input` would be undefined. A service starts an entry with `{"input": {...}}` (`entryArgs` in
  // src/adapters/windmill/client.ts), so the one parameter must be called `input`.
  const mainOf = (file: string) => {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );
    const declarations = source.statements.filter(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === "main",
    );
    const asVariable = source.statements.some(
      (s) =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations.some(
          (d) => ts.isIdentifier(d.name) && d.name.text === "main",
        ),
    );
    const main = declarations[0];
    const kinds = (main?.modifiers ?? []).map((m) => m.kind);
    return {
      declarations: declarations.length,
      asVariable,
      exported: kinds.includes(ts.SyntaxKind.ExportKeyword),
      async: kinds.includes(ts.SyntaxKind.AsyncKeyword),
      body: main?.body !== undefined,
      params: (main?.parameters ?? []).map((p) =>
        ts.isIdentifier(p.name) ? p.name.text : "<pattern>",
      ),
    };
  };

  it.each(description.flows.map((flow) => [flow.name, flow.entry] as const))(
    "%s declares `export async function main`, with `input` as its one parameter or none",
    (_name, entry) => {
      const main = mainOf(entry);
      expect(main).toMatchObject({
        declarations: 1,
        asVariable: false,
        exported: true,
        async: true,
        body: true,
      });
      expect([[], ["input"]]).toContainEqual(main.params);
    },
  );

  it("takes `input` on every entry a service starts and none on a schedule", () => {
    const started = [
      PLAN_APPROVAL_FLOW_PATH,
      ...RECEIVER_FLOW_PATHS,
      ...RUN_WATCHER_FLOW_PATHS,
    ];
    for (const flow of description.flows) {
      const params = mainOf(flow.entry).params;
      if (started.includes(flow.path)) expect(params, flow.name).toEqual(["input"]);
      if (flow.trigger === "schedule") expect(params, flow.name).toEqual([]);
    }
  });

  it("the check catches the arrow form Windmill does not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-"));
    const file = join(dir, "entry.ts");
    writeFileSync(
      file,
      "export const main = (input: unknown) => Promise.resolve(input);\n",
    );
    expect(mainOf(file)).toMatchObject({ declarations: 0, asVariable: true });
    writeFileSync(file, "export function main(args: unknown) { return args; }\n");
    expect(mainOf(file)).toMatchObject({ async: false, params: ["args"] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("each entry's job token scopes (unit: repo guard, D-371, O-121)", () => {
  it("caps every entry to reading the folder's variables, and adds the usage read on the reconcile flow only", () => {
    expect(description.workspace_folder).toBe(WINDMILL_FOLDER);
    for (const flow of description.flows) {
      expect(flow.job_token_scopes, flow.name).toEqual(
        flow.name === "reconcile"
          ? [READ_VARIABLES_SCOPE, READ_USAGE_SCOPE]
          : [READ_VARIABLES_SCOPE],
      );
    }
  });

  it("reads the execution count only in the reconcile flow, so only it needs the usage read", () => {
    const flowFiles = [
      ...entryFiles,
      ...readdirSync("flows/lib")
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join("flows/lib", name)),
    ];
    const readers = flowFiles
      .filter((file) => readFileSync(file, "utf8").includes("executionsThisMonth"))
      .sort();
    expect(readers).toEqual([
      "flows/lib/compose.ts",
      "flows/lib/environment.ts",
      "flows/lib/windmill.ts",
      "flows/reconcile.ts",
    ]);
  });

  it("reads every secret and value at the Windmill path the file gives it (D-370)", () => {
    const named = [
      ...description.resources.secrets.map((s) => [s.path, s.windmill_path]),
      ...description.resources.values.map((v) => [v.name, v.windmill_path]),
      ...description.resources.github_apps.secrets.map((s) => [
        s.path,
        s.windmill_path,
      ]),
      ...description.resources.github_apps.values.map((v) => [v.name, v.windmill_path]),
    ] as [string, string | undefined][];
    expect(named.length).toBeGreaterThan(0);
    for (const [path, windmillPath] of named) {
      // Without a `windmill_path`, the variable is at the folder followed by its name.
      expect(windmillVariablePath(path), path).toBe(
        windmillPath ?? `${WINDMILL_FOLDER}/${path}`,
      );
    }
  });

  it("needs no Windmill token of its own for the execution count", () => {
    expect(description.resources.windmill_token).toBeUndefined();
    const runbook = readFileSync("docs/runbooks/first-hosting.md", "utf8");
    expect(runbook).not.toMatch(/token that can list the workspace's jobs/);
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

describe("the flows the GitHub receiver starts (unit: repo guard, D-291, O-101, O-104, O-114, O-116)", () => {
  it("are the called option capture, advance, staging deploy and access removal flows, at the paths the receiver's ports start, and nothing else", () => {
    expect(RECEIVER_FLOW_PATHS).toEqual([
      OPTION_CAPTURE_FLOW_PATH,
      ADVANCE_ITEM_FLOW_PATH,
      DEPLOY_STAGING_FLOW_PATH,
      REMOVE_BOOTSTRAP_ACCESS_FLOW_PATH,
    ]);
    // The staging flow `deployment_status` started is gone with its start (D-356).
    expect(description.flows.map((f) => f.name)).not.toContain("verify_staging");
    for (const path of RECEIVER_FLOW_PATHS) {
      const flow = description.flows.find((f) => f.path === path);
      expect(flow?.trigger, path).toBe("called");
    }
    expect(
      RECEIVER_FLOW_PATHS.map(
        (path) => description.flows.find((f) => f.path === path)?.entry,
      ),
    ).toEqual([
      "flows/option-capture.ts",
      "flows/advance-item.ts",
      "flows/deploy-staging.ts",
      "flows/remove-bootstrap-access.ts",
    ]);
  });

  it("the first-hosting runbook creates each token with exactly its flows' run scopes", () => {
    const runbook = readFileSync("docs/runbooks/first-hosting.md", "utf8");
    const scopes = (text: string) =>
      [...text.matchAll(/`(jobs:run:scripts:[^`]+)`/g)].map((m) => m[1]);
    // One line per token: each names the cluster Secret it goes into and its scopes, and nothing
    // more. The token lives only there and in its `platform` environment secret (D-351).
    const lineFor = (secret: string) =>
      runbook
        .split("\n")
        .find((line) => line.includes(`\`${secret}\``) && line.includes("jobs:run:"));
    expect(scopes(lineFor(PLATFORM_SECRETS.stateApiWindmillToken.name) ?? "")).toEqual([
      runScope(PLAN_APPROVAL_FLOW_PATH),
    ]);
    expect(scopes(lineFor(PLATFORM_SECRETS.receiverWindmillToken.name) ?? "")).toEqual(
      RECEIVER_FLOW_PATHS.map(runScope),
    );
    expect(
      scopes(lineFor(PLATFORM_SECRETS.runWatcherWindmillToken.name) ?? ""),
    ).toEqual(RUN_WATCHER_FLOW_PATHS.map(runScope));
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

describe("Didi's register-project form (unit: repo guard, D-345, O-109)", () => {
  it("is a called flow, never on a schedule, and no service's Windmill token can start it", () => {
    const flow = description.flows.find((f) => f.name === "register_project");
    expect(flow?.path).toBe("f/foreman/register_project");
    expect(flow?.trigger).toBe("called");
    expect(flow?.entry).toBe("flows/register-project.ts");
    expect(flow?.schedule).toBeUndefined();
    expect([
      PLAN_APPROVAL_FLOW_PATH,
      ...RECEIVER_FLOW_PATHS,
      ...RUN_WATCHER_FLOW_PATHS,
    ]).not.toContain(flow?.path);
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
