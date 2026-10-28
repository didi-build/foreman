import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditPreviewRepository } from "../scripts/check-preview-workflow.mjs";
import {
  REGRESSION_PRE_PR_WRANGLER_PREVIEW_LINE,
  findPreviewConfigViolations,
  findPreviewD1BindingViolations,
  findPreviewIsolationViolations,
  findProductionTokenReferencesInText,
  findPullRequestWorkflowViolations,
  findSharedResourceIdViolations,
  findWranglerInvocationViolations,
  MSG_NO_SUBCOMMAND,
  MSG_PREVIEW_CLOUDFLARE_ENV,
  MSG_PREVIEW_CONFIG_ENV_KEY,
  MSG_PREVIEW_ENV_SELECTION,
  MSG_WORKFLOW_CLOUDFLARE_ENV_PREVIEW,
  workflowOnTriggersPullRequest,
} from "../scripts/lib/preview-workflow-guard.mjs";
import {
  collectWranglerConfigPaths,
  joinShellContinuationLines,
  validateWranglerConfigPaths,
} from "../scripts/lib/wrangler-config-path.mjs";
import { parseWranglerInvocation } from "../scripts/lib/wrangler-invocation-parse.mjs";
import { deletePreviewByName } from "../scripts/lib/wrangler-preview-delete-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliScript = join(root, "scripts/check-preview-workflow.mjs");

const WRANGLER_PROD = `{"name":"launchpad","compatibility_date":"2026-10-26"}\n`;
const WRANGLER_PREVIEW = `{"name":"launchpad-preview","compatibility_date":"2026-10-26","workers_dev":true,"preview_urls":true}\n`;

function runCli(cwd: string) {
  try {
    execFileSync("node", [cliScript], { cwd, encoding: "utf8", stdio: "pipe" });
    return { status: 0, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? 1, stderr: e.stderr ?? "" };
  }
}

function seedRepo(dir: string) {
  writeFileSync(join(dir, "wrangler.jsonc"), WRANGLER_PROD);
  writeFileSync(join(dir, "wrangler.preview.jsonc"), WRANGLER_PREVIEW);
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(dir, ".github/workflows/preview.yml"),
    readFileSync(join(root, ".github/workflows/preview.yml"), "utf8"),
  );
}

function auditMessages(dir: string) {
  return auditPreviewRepository(dir).flatMap((entry) => entry.messages);
}

function withPreviewFixture(
  previewExtra: Record<string, unknown>,
  prodExtra: Record<string, unknown> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "preview-wf-fixture-"));
  const prod = {
    name: "launchpad",
    compatibility_date: "2026-10-26",
    ...prodExtra,
  };
  const preview = {
    name: "launchpad-preview",
    compatibility_date: "2026-10-26",
    workers_dev: true,
    preview_urls: true,
    ...previewExtra,
  };
  writeFileSync(join(dir, "wrangler.jsonc"), `${JSON.stringify(prod)}\n`);
  writeFileSync(join(dir, "wrangler.preview.jsonc"), `${JSON.stringify(preview)}\n`);
  const messages = findPreviewConfigViolations(dir);
  rmSync(dir, { recursive: true, force: true });
  return messages;
}

describe("preview-workflow guard (unit)", () => {
  it("detects pull_request triggers from parsed on: keys only", () => {
    expect(workflowOnTriggersPullRequest({ push: { branches: ["main"] } })).toBe(false);
    expect(workflowOnTriggersPullRequest({ pull_request: {} })).toBe(true);
    expect(workflowOnTriggersPullRequest({ pull_request_review: {} })).toBe(true);
    expect(workflowOnTriggersPullRequest({ pull_request_review_comment: {} })).toBe(
      true,
    );
    expect(workflowOnTriggersPullRequest("pull_request")).toBe(true);
  });

  it("detects production token dot, bracket, and toJSON(secrets) forms", () => {
    expect(
      findProductionTokenReferencesInText("token: ${{ secrets.CLOUDFLARE_API_TOKEN }}"),
    ).not.toEqual([]);
    expect(
      findProductionTokenReferencesInText(
        "token: ${{ secrets.CLOUDFLARE_API_TOKEN || '' }}",
      ),
    ).not.toEqual([]);
    expect(
      findProductionTokenReferencesInText("secrets[ 'CLOUDFLARE_API_TOKEN' ]"),
    ).not.toEqual([]);
    expect(
      findProductionTokenReferencesInText("secrets['CLOUDFLARE_API_TOKEN']"),
    ).not.toEqual([]);
    expect(
      findProductionTokenReferencesInText(
        "format('{0}', secrets.cloudflare_api_token)",
      ),
    ).not.toEqual([]);
    expect(findProductionTokenReferencesInText("toJSON(secrets)")).not.toEqual([]);
    expect(findProductionTokenReferencesInText("secrets: inherit")).not.toEqual([]);
    expect(
      findProductionTokenReferencesInText(
        "${{ secrets.CLOUDFLARE_API_TOKEN_PREVIEW }}",
      ),
    ).toEqual([]);
  });
});

describe("preview-workflow guard regressions (unit)", () => {
  it("blocks the exact pre-PR wrangler preview deploy line (no -c)", () => {
    const violations = findWranglerInvocationViolations(
      REGRESSION_PRE_PR_WRANGLER_PREVIEW_LINE,
      "launchpad",
    );
    expect(violations.some((v) => v.includes("wrangler.preview.jsonc"))).toBe(true);
  });

  it("blocks wrangler preview delete without WRANGLER_CONFIG in the delete helper", () => {
    const prev = process.env.WRANGLER_CONFIG;
    delete process.env.WRANGLER_CONFIG;
    expect(deletePreviewByName("pr-1", { encoding: "utf8", env: process.env })).toBe(1);
    if (prev !== undefined) {
      process.env.WRANGLER_CONFIG = prev;
    }
  });

  it("blocks wrangler preview delete when WRANGLER_CONFIG is not wrangler.preview.jsonc", () => {
    const prev = process.env.WRANGLER_CONFIG;
    process.env.WRANGLER_CONFIG = "wrangler.jsonc";
    expect(deletePreviewByName("pr-1", { encoding: "utf8", env: process.env })).toBe(1);
    if (prev !== undefined) {
      process.env.WRANGLER_CONFIG = prev;
    } else {
      delete process.env.WRANGLER_CONFIG;
    }
  });

  it("blocks --worker-name launchpad in pull request workflows", () => {
    const workflow = {
      on: { pull_request: {} },
      jobs: {
        preview: {
          steps: [
            {
              run: 'npx wrangler preview -c wrangler.preview.jsonc --worker-name launchpad --name "pr-1"',
            },
          ],
        },
      },
      __rawText: "",
    };
    const messages = findPullRequestWorkflowViolations(
      workflow,
      "preview.yml",
      "launchpad",
    );
    expect(messages.some((m) => m.includes("--worker-name"))).toBe(true);
  });

  it("blocks an extra wrangler deploy step in pull request workflows", () => {
    const workflow = {
      on: { pull_request: {} },
      jobs: {
        bad: {
          steps: [{ run: "npx wrangler deploy" }],
        },
      },
      __rawText: "",
    };
    const messages = findPullRequestWorkflowViolations(
      workflow,
      "preview.yml",
      "launchpad",
    );
    expect(messages.some((m) => m.includes("forbidden wrangler deploy"))).toBe(true);
  });

  it("blocks bracket production token references in pull request workflows", () => {
    const workflow = {
      on: { pull_request: {} },
      jobs: { x: { steps: [{ run: "echo ok" }] } },
      __rawText: "secrets['CLOUDFLARE_API_TOKEN']",
    };
    const messages = findPullRequestWorkflowViolations(
      workflow,
      "preview.yml",
      "launchpad",
    );
    expect(messages.some((m) => m.includes("CLOUDFLARE_API_TOKEN"))).toBe(true);
  });

  it("blocks toJSON(secrets) in pull request workflows", () => {
    const workflow = {
      on: { pull_request: {} },
      jobs: { x: { steps: [{ run: "echo ok" }] } },
      __rawText: "const all = toJSON(secrets)",
    };
    const messages = findPullRequestWorkflowViolations(
      workflow,
      "preview.yml",
      "launchpad",
    );
    expect(messages.some((m) => m.includes("toJSON(secrets)"))).toBe(true);
  });

  it("blocks environment: production in pull request workflows", () => {
    const workflow = {
      on: { pull_request: {} },
      jobs: {
        deploy: {
          environment: "production",
          steps: [{ run: "echo deploy" }],
        },
      },
      __rawText: "",
    };
    const messages = findPullRequestWorkflowViolations(
      workflow,
      "preview.yml",
      "launchpad",
    );
    expect(messages.some((m) => m.includes("environment: production"))).toBe(true);
  });

  it("fails when preview.yml is renamed to preview.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-wf-rename-"));
    writeFileSync(join(dir, "wrangler.jsonc"), WRANGLER_PROD);
    writeFileSync(join(dir, "wrangler.preview.jsonc"), WRANGLER_PREVIEW);
    const workflows = join(dir, ".github/workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(workflows, "preview.yaml"), "on:\n  pull_request:\n");
    const messages = auditMessages(dir);
    expect(messages.some((m) => m.includes("preview.yml"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails when wrangler.preview.jsonc is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-wf-missing-config-"));
    writeFileSync(join(dir, "wrangler.jsonc"), WRANGLER_PROD);
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/preview.yml"), "on:\n  pull_request:\n");
    expect(findPreviewConfigViolations(dir).some((m) => m.includes("missing"))).toBe(
      true,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails when deploy step drops -c wrangler.preview.jsonc but cleanup still mentions the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-wf-no-c-"));
    seedRepo(dir);
    const previewPath = join(dir, ".github/workflows/preview.yml");
    let yaml = readFileSync(previewPath, "utf8");
    yaml = yaml.replace(
      "npx wrangler preview -c wrangler.preview.jsonc",
      "npx wrangler preview",
    );
    writeFileSync(previewPath, yaml);
    const messages = auditMessages(dir);
    expect(messages.some((m) => m.includes("wrangler.preview.jsonc"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails when cleanup omits WRANGLER_CONFIG for wrangler-preview-delete.mjs", () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-wf-no-wrangler-config-"));
    seedRepo(dir);
    const previewPath = join(dir, ".github/workflows/preview.yml");
    let yaml = readFileSync(previewPath, "utf8");
    yaml = yaml.replace("\n          WRANGLER_CONFIG: wrangler.preview.jsonc\n", "\n");
    writeFileSync(previewPath, yaml);
    const messages = auditMessages(dir);
    expect(messages.some((m) => m.includes("WRANGLER_CONFIG"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("preview-workflow guard round 2 bypasses (unit)", () => {
  function prWorkflow(run: string) {
    return {
      on: { pull_request: {} },
      jobs: { preview: { steps: [{ run }] } },
      __rawText: "",
    };
  }

  it("blocks shell continuation with --worker-name on the next line", () => {
    const run = `npx wrangler preview \\
  --worker-name launchpad --name "pr-1"`;
    const joined = joinShellContinuationLines(run);
    const messages = findPullRequestWorkflowViolations(
      prWorkflow(run),
      "preview.yml",
      "launchpad",
    );
    expect(joined).toContain("--worker-name launchpad");
    expect(messages.some((m) => m.includes("--worker-name"))).toBe(true);
  });

  it("blocks a second production config flag after the preview config", () => {
    const run =
      "npx wrangler preview -c wrangler.preview.jsonc --config=wrangler.jsonc --name pr-1";
    expect(
      validateWranglerConfigPaths(collectWranglerConfigPaths(run)).some((v) =>
        v.includes("wrangler.jsonc"),
      ),
    ).toBe(true);
    const messages = findPullRequestWorkflowViolations(
      prWorkflow(run),
      "preview.yml",
      "launchpad",
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("blocks -c ./wrangler.jsonc", () => {
    const run = "npx wrangler preview -c ./wrangler.jsonc --name pr-1";
    const messages = findPullRequestWorkflowViolations(
      prWorkflow(run),
      "preview.yml",
      "launchpad",
    );
    expect(messages.some((m) => m.includes("wrangler.jsonc"))).toBe(true);
  });

  it("blocks secrets: inherit on a reusable workflow call", () => {
    const workflow = {
      on: { pull_request: {} },
      jobs: {
        call: {
          uses: "./.github/workflows/other.yml",
          secrets: "inherit",
          steps: [],
        },
      },
      __rawText: "",
    };
    const messages = findPullRequestWorkflowViolations(
      workflow,
      "preview.yml",
      "launchpad",
    );
    expect(messages.some((m) => m.includes("secrets: inherit"))).toBe(true);
  });

  it("blocks preview D1 bindings that reuse a production database_id under another name", () => {
    const production = {
      d1_databases: [
        { binding: "DB", database_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      ],
    };
    const preview = {
      d1_databases: [
        {
          binding: "PREVIEW_DB",
          database_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        },
      ],
    };
    expect(findSharedResourceIdViolations(production, preview)).not.toEqual([]);
  });
});

describe("preview-workflow guard DIDI-915 (unit)", () => {
  function prWorkflow(run: string) {
    return {
      on: { pull_request: {} },
      jobs: { preview: { steps: [{ run }] } },
      __rawText: "",
    };
  }

  it("blocks npx wrangler@4.152.0 preview with no -c", () => {
    const violations = findWranglerInvocationViolations(
      "npx wrangler@4.152.0 preview --name pr-1",
      "launchpad",
    );
    expect(violations.some((v) => v.includes("wrangler.preview.jsonc"))).toBe(true);
  });

  it("blocks npx wrangler@latest preview -c wrangler.jsonc", () => {
    const violations = findWranglerInvocationViolations(
      "npx wrangler@latest preview -c wrangler.jsonc --name pr-1",
      "launchpad",
    );
    expect(violations.some((v) => v.includes("wrangler.jsonc"))).toBe(true);
  });

  it("blocks bunx wrangler@latest deploy", () => {
    const violations = findWranglerInvocationViolations(
      "bunx wrangler@latest deploy",
      "launchpad",
    );
    expect(violations.some((v) => v.includes("forbidden wrangler deploy"))).toBe(true);
  });

  it("allows -c=wrangler.preview.jsonc on wrangler preview", () => {
    const run = "npx wrangler preview -c=wrangler.preview.jsonc --name pr-1";
    expect(validateWranglerConfigPaths(collectWranglerConfigPaths(run))).toEqual([]);
    const messages = findPullRequestWorkflowViolations(
      prWorkflow(run),
      "preview.yml",
      "launchpad",
    );
    expect(messages).toEqual([]);
  });

  it("blocks -c wrangler.preview.jsonc together with -c=wrangler.jsonc", () => {
    const run =
      "npx wrangler preview -c wrangler.preview.jsonc -c=wrangler.jsonc --name pr-1";
    expect(
      validateWranglerConfigPaths(collectWranglerConfigPaths(run)).some((v) =>
        v.includes("wrangler.jsonc"),
      ),
    ).toBe(true);
    const messages = findPullRequestWorkflowViolations(
      prWorkflow(run),
      "preview.yml",
      "launchpad",
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("blocks preview D1 preview_database_id shared with production", () => {
    const production = {
      d1_databases: [
        {
          binding: "DB",
          database_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          preview_database_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        },
      ],
    };
    const preview = {
      d1_databases: [
        {
          binding: "PREVIEW_DB",
          database_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          preview_database_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        },
      ],
    };
    expect(findSharedResourceIdViolations(production, preview)).not.toEqual([]);
  });

  it("blocks preview KV preview_id shared with production", () => {
    const production = {
      kv_namespaces: [
        {
          binding: "KV",
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          preview_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ],
    };
    const preview = {
      kv_namespaces: [
        {
          binding: "PREVIEW_KV",
          id: "cccccccccccccccccccccccccccccccc",
          preview_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ],
    };
    expect(findSharedResourceIdViolations(production, preview)).not.toEqual([]);
  });

  it("fails when preview D1 has database_name but no database_id", () => {
    const preview = {
      d1_databases: [{ binding: "DB", database_name: "my-db" }],
    };
    expect(findPreviewD1BindingViolations(preview).length).toBeGreaterThan(0);
  });

  it("fails when preview config service binding targets production Worker", () => {
    const violations = findPreviewIsolationViolations(
      { services: [{ binding: "API", service: "launchpad" }] },
      "launchpad",
    );
    expect(violations.some((v) => v.includes("production Worker"))).toBe(true);
  });

  it("fails when preview config defines routes", () => {
    expect(
      findPreviewIsolationViolations({ routes: [{ pattern: "example.com/*" }] }, "x"),
    ).not.toEqual([]);
  });

  it("fails when preview config defines route", () => {
    expect(
      findPreviewIsolationViolations({ route: { pattern: "example.com/*" } }, "x"),
    ).not.toEqual([]);
  });

  it("fails when preview config defines custom_domains", () => {
    expect(
      findPreviewIsolationViolations({ custom_domains: ["preview.example.com"] }, "x"),
    ).not.toEqual([]);
  });
});

describe("preview-workflow guard DIDI-915 QA round 2 (unit)", () => {
  function prWorkflow(run: string) {
    return {
      on: { pull_request: {} },
      jobs: { preview: { steps: [{ run }] } },
      __rawText: "",
    };
  }

  it("rejects two non-production config paths", () => {
    const eqForm =
      "npx wrangler preview -c=wrangler.preview.jsonc -c other.jsonc --name pr-1";
    const spacedForm =
      "npx wrangler preview -c wrangler.preview.jsonc --config wrangler.preview.jsonc --name pr-1";
    for (const run of [eqForm, spacedForm]) {
      const violations = validateWranglerConfigPaths(collectWranglerConfigPaths(run));
      expect(violations.some((v) => v.includes("exactly one config path"))).toBe(true);
    }
  });

  it("findPreviewConfigViolations fails for D1 database_name without database_id (fixture)", () => {
    const messages = withPreviewFixture({
      d1_databases: [{ binding: "DB", database_name: "my-db" }],
    });
    expect(messages.some((m) => m.includes("database_name but no database_id"))).toBe(
      true,
    );
  });

  it("findPreviewConfigViolations fails for prod service binding (fixture)", () => {
    const messages = withPreviewFixture({
      services: [{ binding: "API", service: "launchpad" }],
    });
    expect(messages.some((m) => m.includes("production Worker"))).toBe(true);
  });

  it("findPreviewConfigViolations fails for routes, route and custom_domains (fixture)", () => {
    for (const extra of [
      { routes: [{ pattern: "example.com/*" }] },
      { route: { pattern: "example.com/*" } },
      { custom_domains: ["x.example.com"] },
    ]) {
      const messages = withPreviewFixture(extra);
      expect(messages.length).toBeGreaterThan(0);
    }
  });

  it("findPreviewConfigViolations rejects any env key in wrangler.preview.jsonc (fixture)", () => {
    const messages = withPreviewFixture({
      env: {
        staging: {
          name: "launchpad",
          workers_dev: false,
          d1_databases: [
            { binding: "DB", database_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
          ],
        },
      },
    });
    expect(messages.some((m) => m.includes(MSG_PREVIEW_CONFIG_ENV_KEY))).toBe(true);
  });

  it("detects cross-field D1 id sharing between database_id and preview_database_id", () => {
    const shared = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const production = {
      d1_databases: [{ binding: "DB", database_id: shared }],
    };
    const preview = {
      d1_databases: [{ binding: "P", preview_database_id: shared }],
    };
    expect(findSharedResourceIdViolations(production, preview)).not.toEqual([]);
    const reverse = findSharedResourceIdViolations(
      { d1_databases: [{ preview_database_id: shared }] },
      { d1_databases: [{ database_id: shared }] },
    );
    expect(reverse).not.toEqual([]);
  });

  it("detects cross-field KV id sharing between id and preview_id", () => {
    const shared = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(
      findSharedResourceIdViolations(
        { kv_namespaces: [{ binding: "KV", id: shared }] },
        { kv_namespaces: [{ binding: "P", preview_id: shared }] },
      ),
    ).not.toEqual([]);
  });

  it("blocks flags-before-subcommand deploy bypasses", () => {
    const cases = [
      "npx wrangler -c wrangler.jsonc deploy",
      "npx wrangler --config wrangler.preview.jsonc deploy",
      "npx wrangler --cwd . deploy",
      "wrangler -e production deploy",
      "npm exec wrangler -- deploy",
    ];
    for (const run of cases) {
      const direct = findWranglerInvocationViolations(run, "launchpad", {
        fullLine: run,
      });
      const workflow = findPullRequestWorkflowViolations(
        prWorkflow(run),
        "preview.yml",
        "launchpad",
      );
      expect(direct.length + workflow.length).toBeGreaterThan(0);
    }
  });

  it("rejects wrangler preview environment selection in workflow runs", () => {
    const previewBase = "npx wrangler preview -c wrangler.preview.jsonc --name pr-1";
    const cases: { run: string; message: string }[] = [
      { run: `${previewBase} -e production`, message: MSG_PREVIEW_ENV_SELECTION },
      { run: `${previewBase} -e=production`, message: MSG_PREVIEW_ENV_SELECTION },
      { run: `${previewBase} --env production`, message: MSG_PREVIEW_ENV_SELECTION },
      { run: `${previewBase} --env=Production`, message: MSG_PREVIEW_ENV_SELECTION },
      { run: `${previewBase} -e "production"`, message: MSG_PREVIEW_ENV_SELECTION },
      { run: `${previewBase} --env=staging`, message: MSG_PREVIEW_ENV_SELECTION },
      {
        run: `CLOUDFLARE_ENV=production ${previewBase}`,
        message: MSG_PREVIEW_CLOUDFLARE_ENV,
      },
      {
        run: `FOO=1 CLOUDFLARE_ENV=production ${previewBase}`,
        message: MSG_PREVIEW_CLOUDFLARE_ENV,
      },
    ];
    for (const { run, message } of cases) {
      const workflow = findPullRequestWorkflowViolations(
        prWorkflow(run),
        "preview.yml",
        "launchpad",
      );
      expect(workflow.some((m) => m.includes(message))).toBe(true);
    }
  });

  it("rejects CLOUDFLARE_ENV in workflow, job and step env on preview steps", () => {
    const previewRun = "npx wrangler preview -c wrangler.preview.jsonc --name pr-1";
    for (const workflow of [
      {
        on: { pull_request: {} },
        env: { CLOUDFLARE_ENV: "staging" },
        jobs: { preview: { steps: [{ run: previewRun }] } },
        __rawText: "",
      },
      {
        on: { pull_request: {} },
        jobs: {
          preview: {
            env: { CLOUDFLARE_ENV: "staging" },
            steps: [{ run: previewRun }],
          },
        },
        __rawText: "",
      },
      {
        on: { pull_request: {} },
        jobs: {
          preview: {
            steps: [{ run: previewRun, env: { CLOUDFLARE_ENV: "staging" } }],
          },
        },
        __rawText: "",
      },
    ]) {
      const messages = findPullRequestWorkflowViolations(
        workflow,
        "preview.yml",
        "launchpad",
      );
      expect(
        messages.some((m) => m.includes(MSG_WORKFLOW_CLOUDFLARE_ENV_PREVIEW)),
      ).toBe(true);
    }
  });

  it("fail-closed when wrangler has config flags but no subcommand", () => {
    const run = "npx wrangler -c wrangler.preview.jsonc";
    const violations = findWranglerInvocationViolations(run, "launchpad", {
      fullLine: run,
    });
    expect(violations).toContain(MSG_NO_SUBCOMMAND);
    expect(
      findPullRequestWorkflowViolations(
        prWorkflow(run),
        "preview.yml",
        "launchpad",
      ).some((m) => m.includes(MSG_NO_SUBCOMMAND)),
    ).toBe(true);
  });

  it("blocks quoted versioned wrangler deploy", () => {
    for (const run of ['npx "wrangler@4" deploy', "npx 'wrangler@latest' deploy"]) {
      const violations = findWranglerInvocationViolations(run, "launchpad", {
        fullLine: run,
      });
      expect(violations.some((m) => m.includes("forbidden wrangler deploy"))).toBe(
        true,
      );
    }
  });

  it("parseWranglerInvocation skips flags before the subcommand", () => {
    expect(
      parseWranglerInvocation("npx wrangler -c wrangler.jsonc deploy").subcommand,
    ).toBe("deploy");
    expect(parseWranglerInvocation("wrangler --cwd . deploy").subcommand).toBe(
      "deploy",
    );
  });

  it("blocks quoted wrangler and shell continuation without space before backslash", () => {
    expect(
      findWranglerInvocationViolations('npx "wrangler" deploy', "launchpad").length,
    ).toBeGreaterThan(0);
    const run = `npx wrangler\\
  deploy`;
    const joined = joinShellContinuationLines(run);
    expect(joined).toBe("npx wrangler deploy");
    const messages = findPullRequestWorkflowViolations(
      prWorkflow(run),
      "preview.yml",
      "launchpad",
    );
    expect(messages.some((m) => m.includes("forbidden wrangler deploy"))).toBe(true);
  });

  it("findPreviewConfigViolations catches minor isolation gaps (fixture)", () => {
    const emptyD1 = withPreviewFixture({ d1_databases: [{}] });
    expect(emptyD1.some((m) => m.includes("empty"))).toBe(true);
    const caseService = withPreviewFixture({
      services: [{ binding: "API", service: "Launchpad" }],
    });
    expect(caseService.some((m) => m.includes("production Worker"))).toBe(true);
    const tail = withPreviewFixture({
      tail_consumers: [{ service: "launchpad" }],
    });
    expect(tail.some((m) => m.includes("tail_consumers"))).toBe(true);
    const durable = withPreviewFixture({
      durable_objects: {
        bindings: [{ name: "DO", class_name: "C", script_name: "launchpad" }],
      },
    });
    expect(durable.some((m) => m.includes("durable_objects binding"))).toBe(true);
  });
});

describe("check-preview-workflow CLI (subprocess)", () => {
  it("exits 0 for the Launchpad template checkout", () => {
    expect(runCli(root).status).toBe(0);
  });
});
