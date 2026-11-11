// Unit: repo guard on the admin workflows (D-336, D-339, D-340, O-105, D-362, O-115, D-371,
// O-123): the Images, Infra apply, Platform, Database migrations and Windmill deploy workflows,
// the scripts they run, the cluster's settings file and the factory stack's reviewed variables. Read as text and YAML (and the scripts' modes from git's index); nothing runs. The scripts' behaviour is in
// test/admin-workflow-scripts.test.ts.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { PLATFORM_SECRETS } from "../infra/kubernetes/platform.ts";
import { MIGRATIONS_DIR } from "../src/adapters/store-postgres/migrate.ts";
import { SUPABASE_CA_PATH } from "../src/adapters/store-postgres/tls.ts";
import { clusterObjects } from "../infra/kubernetes/render.ts";
import { DEFAULT_PRIVILEGED_PATHS, globToRegExp } from "../src/core/guards/review.ts";
import {
  AGENT_RUNS_FILE,
  DEPLOYED_VALUES,
  PLATFORM_SETTINGS_FILE,
} from "../scripts/windmill-bundle.ts";
import {
  RENDER_PLACEHOLDER,
  SETTINGS_FILE,
  committedSettings,
  filledSettings,
  renderedObjects,
} from "./admin-workflows-fixture.ts";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  if?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<
    string,
    { branches?: string[]; paths?: string[]; inputs?: unknown } | null
  >;
  permissions: unknown;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const WORKFLOWS = {
  images: ".github/workflows/images.yml",
  infra: ".github/workflows/infra-apply.yml",
  platform: ".github/workflows/platform.yml",
  database: ".github/workflows/db-migrate.yml",
  windmill: ".github/workflows/windmill-deploy.yml",
} as const;
const text = (path: string) => readFileSync(path, "utf8");
const workflow = (path: string) => parseYaml(text(path)) as Workflow;
const all = Object.values(WORKFLOWS).map((path) => ({ path, wf: workflow(path) }));

const SCRIPTS_DIR = ".github/scripts";
// The shell scripts; Bootstrap's Node scripts (.mjs) are held by test/check-bootstrap-isolation.test.ts.
const scripts = readdirSync(SCRIPTS_DIR)
  .filter((name) => name.endsWith(".sh"))
  .map((name) => join(SCRIPTS_DIR, name));
const script = (name: string) => text(join(SCRIPTS_DIR, name));

/** A `${{ ... }}` expression that reads a secret. */
const SECRET_REFERENCE = /\$\{\{[^}]*\bsecrets\./;

/** D-361: the account id, the zone id and the bucket name are organization and repository secrets. */
const JOB_LEVEL_IDENTIFIERS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "STATE_BUCKET",
];
/** The environments: two plan environments with no reviewer (D-339), four Didi approves (D-339, D-362, D-371). */
const PLAN_ENVIRONMENTS = ["infra-plan", "platform-plan"];
const APPROVED_ENVIRONMENTS = ["infra", "platform", "database", "windmill"];

describe("the admin workflows (unit: repo guard, D-339, D-340, O-105)", () => {
  it("run only from main, on a push there or by hand, never on a pull request", () => {
    for (const { path, wf } of all) {
      expect(Object.keys(wf.on).sort(), path).toEqual(["push", "workflow_dispatch"]);
      expect(wf.on.push?.branches, path).toEqual(["main"]);
      for (const [id, job] of Object.entries(wf.jobs)) {
        expect(job.if ?? "", `${path} ${id}`).toContain(
          "github.ref == 'refs/heads/main'",
        );
      }
      expect(text(path), path).not.toMatch(/pull_request|workflow_run/);
    }
  });

  it("hold no permission at the top, and each job only contents: read, the images job also packages: write", () => {
    for (const { path, wf } of all) {
      expect(wf.permissions, path).toEqual({});
      for (const [id, job] of Object.entries(wf.jobs)) {
        const expected =
          path === WORKFLOWS.images && id === "build"
            ? { contents: "read", packages: "write" }
            : { contents: "read" };
        expect(job.permissions, `${path} ${id}`).toEqual(expected);
      }
    }
  });

  it("commit every shell script as executable, since a step runs it by its path and not through bash (O-123)", () => {
    // The mode the runner's checkout gets is the one in git, not the one on this disk. Each line
    // reads "<mode> <object> <stage>\t<path>".
    const modes = new Map(
      execFileSync("git", ["ls-files", "-s", "--", SCRIPTS_DIR], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => {
          const [entry = "", path = ""] = line.split("\t");
          return [path, entry.split(" ")[0]] as const;
        }),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const path of scripts) expect(modes.get(path), path).toBe("100755");
  });

  it("pin every action by full commit SHA with its version, the same SHA as everywhere else in the repo", () => {
    const pins = new Map<string, Set<string>>();
    for (const name of readdirSync(".github/workflows")) {
      for (const match of text(join(".github/workflows", name)).matchAll(
        /uses:\s+([^@\s]+)@(\S+)(.*)$/gm,
      )) {
        const [, action, ref, rest] = match as unknown as [
          string,
          string,
          string,
          string,
        ];
        if (
          Object.values(WORKFLOWS).includes(join(".github/workflows", name) as never)
        ) {
          expect(ref, `${name} ${action}`).toMatch(/^[0-9a-f]{40}$/);
          expect(rest, `${name} ${action}`).toMatch(/^\s+#\s+v\d+\.\d+\.\d+$/);
        }
        const key = `${action} ${rest.trim()}`;
        pins.set(key, (pins.get(key) ?? new Set()).add(ref));
      }
    }
    for (const [key, refs] of pins) expect([...refs], key).toHaveLength(1);
  });

  it("read secrets only in jobs of the six environments, only in a step's env, never in a script", () => {
    for (const { path, wf } of all) {
      const raw = text(path);
      expect(raw, path).not.toMatch(/toJSON\(secrets\)|secrets:\s*inherit|secrets\[/);
      for (const [id, job] of Object.entries(wf.jobs)) {
        const label = `${path} ${id}`;
        const usesSecrets = SECRET_REFERENCE.test(JSON.stringify(job));
        if (usesSecrets) {
          expect([...PLAN_ENVIRONMENTS, ...APPROVED_ENVIRONMENTS], label).toContain(
            job.environment,
          );
        }
        // Only the identifiers of D-361 may sit in a job's env: they are not keys, and every
        // step that redacts or runs `tofu init` needs them. A key stays in a step's env.
        for (const [name, value] of Object.entries(job.env ?? {})) {
          if (SECRET_REFERENCE.test(value)) {
            expect(JOB_LEVEL_IDENTIFIERS, `${label} ${name}`).toContain(name);
            expect(value, `${label} ${name}`).toBe(`\${{ secrets.${name} }}`);
          }
        }
        for (const step of job.steps) {
          expect(step.run ?? "", `${label} ${step.name}`).not.toMatch(SECRET_REFERENCE);
          expect(JSON.stringify(step.with ?? {}), `${label} ${step.name}`).not.toMatch(
            SECRET_REFERENCE,
          );
          for (const value of Object.values(step.env ?? {})) {
            if (SECRET_REFERENCE.test(value)) {
              expect(value, label).toMatch(/^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/);
            }
          }
        }
      }
    }
  });

  it("plan in the plan environments, and apply and set Secrets only in the ones Didi approves", () => {
    const environments = Object.fromEntries(
      all.flatMap(({ path, wf }) =>
        Object.entries(wf.jobs).map(([id, job]) => [
          `${path}#${id}`,
          job.environment ?? null,
        ]),
      ),
    );
    expect(environments).toEqual({
      [`${WORKFLOWS.images}#build`]: null,
      [`${WORKFLOWS.infra}#plan`]: "infra-plan",
      [`${WORKFLOWS.infra}#apply`]: "infra",
      [`${WORKFLOWS.platform}#render`]: null,
      [`${WORKFLOWS.platform}#plan`]: "platform-plan",
      [`${WORKFLOWS.platform}#apply`]: "platform",
      [`${WORKFLOWS.platform}#cluster-secrets`]: "platform",
      [`${WORKFLOWS.platform}#runner-token`]: "platform",
      [`${WORKFLOWS.database}#migrate`]: "database",
      [`${WORKFLOWS.windmill}#bundle`]: null,
      [`${WORKFLOWS.windmill}#deploy`]: "windmill",
    });
  });

  it("run every script step with set -euo pipefail, and never trace a command", () => {
    for (const { path, wf } of all) {
      for (const [id, job] of Object.entries(wf.jobs)) {
        for (const step of job.steps) {
          if (step.run === undefined) continue;
          expect(step.run.split("\n")[0], `${path} ${id} ${step.name}`).toBe(
            "set -euo pipefail",
          );
        }
      }
      expect(text(path), path).not.toMatch(/set -[a-z]*x|set -o xtrace|bash -x/);
    }
    // The shell scripts; CI's preview check scripts are Node (test/preview-check-scripts.test.ts).
    for (const path of scripts.filter((p) => p.endsWith(".sh"))) {
      const lines = text(path).split("\n");
      expect(lines[0], path).toBe("#!/usr/bin/env bash");
      const firstCommand = lines.find(
        (l, i) => i > 0 && l.trim() !== "" && !l.startsWith("#"),
      );
      expect(firstCommand, path).toBe("set -euo pipefail");
      expect(text(path), path).not.toMatch(/set -[a-z]*x|set -o xtrace|bash -x/);
    }
  });

  it("never let two runs of the infra, platform, migrations or Windmill deploy workflow overlap, so two applies never do", () => {
    for (const path of [
      WORKFLOWS.infra,
      WORKFLOWS.platform,
      WORKFLOWS.database,
      WORKFLOWS.windmill,
    ]) {
      const { concurrency } = workflow(path);
      expect(concurrency?.["cancel-in-progress"], path).toBe(false);
      expect(concurrency?.group, path).toMatch(/^[a-z-]+$/);
    }
  });

  it("are privileged paths, as are the secret-value scan that runs with the credentials, the migrations and the CA certificate the migrations job trusts", () => {
    const patterns = DEFAULT_PRIVILEGED_PATHS.map(globToRegExp);
    const privileged = (path: string) => patterns.some((re) => re.test(path));
    for (const path of [
      ...Object.values(WORKFLOWS),
      ...scripts,
      "scripts/find-secret-values.mjs",
      "scripts/lib/find-secret-values.mjs",
      ...readdirSync(MIGRATIONS_DIR).map((name) => join(MIGRATIONS_DIR, name)),
      // O-118: the certificate decides whom the job and the services trust.
      SUPABASE_CA_PATH,
      // O-123: the settings the Windmill deploy writes into Windmill (images, app names, sizes).
      SETTINGS_FILE,
      AGENT_RUNS_FILE,
    ]) {
      expect(privileged(path), path).toBe(true);
    }
  });
});

describe("the infra apply workflow (unit: D-339, ADR 0110)", () => {
  it("reads the account id, the zone id and the bucket name as secrets, and the host name as a variable (D-361)", () => {
    for (const path of [WORKFLOWS.infra, WORKFLOWS.platform]) {
      const raw = text(path);
      expect(raw, path).not.toMatch(
        /vars\.(CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_ZONE_ID|STATE_BUCKET)\b/,
      );
      expect(raw, path).toMatch(/\$\{\{ secrets\.STATE_BUCKET \}\}/);
      expect(raw, path).toMatch(/\$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
    }
    const infra = text(WORKFLOWS.infra);
    expect(infra).toMatch(/\$\{\{ secrets\.CLOUDFLARE_ZONE_ID \}\}/);
    expect(infra).toMatch(/\$\{\{ vars\.RECEIVER_HOSTNAME \}\}/);
    expect(infra).not.toMatch(/secrets\.RECEIVER_HOSTNAME/);
  });

  const wf = workflow(WORKFLOWS.infra);
  const plan = wf.jobs.plan as Job;
  const apply = wf.jobs.apply as Job;
  const planStep = plan.steps.find((s) => s.id === "plan") as Step;

  it("runs tofu with -input=false, the locked providers, no wrapper and the repo's OpenTofu version", () => {
    const tofuLines = [
      ...Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.run ?? "")),
      script("tofu-init.sh"),
    ]
      .join("\n")
      .replace(/\\\n\s*/g, " ")
      .split("\n")
      .filter(
        (l) =>
          /^\s*tofu(\s+-chdir=\S+)?\s+(init|plan|apply)\b/.test(l) &&
          !l.trim().startsWith("#"),
      );
    expect(tofuLines.length).toBeGreaterThanOrEqual(3);
    for (const line of tofuLines) expect(line).toContain("-input=false");
    expect(script("tofu-init.sh")).toContain("-lockfile=readonly");
    const validate = workflow(".github/workflows/infra.yml").jobs.validate as Job;
    const version = validate.steps.find((s) => s.uses?.startsWith("opentofu/"))?.with
      ?.tofu_version;
    for (const job of [plan, apply]) {
      const setup = job.steps.find((s) =>
        s.uses?.startsWith("opentofu/setup-opentofu@"),
      );
      expect(setup?.with).toEqual({ tofu_version: version, tofu_wrapper: false });
    }
  });

  it("scans the plan text for the secret values before it publishes anything, and keeps the JSON form in a pipe", () => {
    const run = planStep.run ?? "";
    const scan = run.indexOf("node scripts/find-secret-values.mjs");
    expect(scan).toBeGreaterThan(0);
    expect(run.indexOf("GITHUB_STEP_SUMMARY")).toBeGreaterThan(scan);
    expect(run.indexOf("redact.sh")).toBeGreaterThan(scan);
    expect(run).toContain(
      "DIGITALOCEAN_TOKEN,CLOUDFLARE_API_TOKEN,AWS_SECRET_ACCESS_KEY,TF_VAR_state_encryption_passphrase",
    );
    expect(run).toContain("RECEIVER_TUNNEL_TOKEN");
    expect(run).toMatch(/show -json plan\.out \|\s*\n\s*jq -c/);
    expect(run).not.toMatch(/show -json plan\.out\s*>/);
  });

  it("plans again when the settings file changes, since the stack reads its project list there (D-357)", () => {
    expect(wf.on.push?.paths).toContain(SETTINGS_FILE);
    expect(text("infra/stacks/factory/main.tf")).toContain(
      'file("${path.module}/../../kubernetes/settings/production.json")',
    );
  });

  it("plans with the reviewed variables file and saves the encrypted plan for one day", () => {
    expect(planStep.run).toContain("-var-file=production.tfvars -out=plan.out");
    const upload = plan.steps.find((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(upload?.with).toMatchObject({
      name: "infra-plan",
      path: "infra/stacks/factory/plan.out",
      "retention-days": 1,
    });
  });

  it("applies exactly the saved plan, only when it has changes", () => {
    expect(apply.needs).toBe("plan");
    expect(apply.if).toContain("needs.plan.outputs.changes == 'true'");
    const download = apply.steps.find((s) =>
      s.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download?.with).toEqual({
      name: "infra-plan",
      path: "infra/stacks/factory",
    });
    const run = apply.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("apply -input=false -no-color -lock-timeout=5m plan.out");
    expect(run).not.toMatch(/apply[^\n]*-auto-approve/);
    // The apply's output is scanned before it is published, and the state through a pipe only.
    expect(run.indexOf("find-secret-values.mjs")).toBeLessThan(
      run.indexOf("GITHUB_STEP_SUMMARY"),
    );
    expect(run).toMatch(
      /state pull \|\s*\n[^\n]*\n\s*node scripts\/find-secret-values\.mjs \/dev\/stdin/,
    );
    expect(run).not.toMatch(/state pull\s*>/);
  });
});

describe("the platform workflow (unit: D-339, D-340)", () => {
  const wf = workflow(WORKFLOWS.platform);

  it("fetches a credential in each job that reaches the cluster, valid for that job's time limit, and removes it", () => {
    const credentialJobs = Object.entries(wf.jobs).filter(([, job]) =>
      job.steps.some((s) => s.run?.includes("cluster-credential.sh")),
    );
    expect(credentialJobs.map(([id]) => id)).toEqual([
      "plan",
      "apply",
      "cluster-secrets",
      "runner-token",
    ]);
    for (const [id, job] of credentialJobs) {
      expect(job.env?.CREDENTIAL_SECONDS, id).toBe(
        String((job["timeout-minutes"] ?? 0) * 60),
      );
      const fetch = job.steps.find((s) =>
        s.run?.includes("cluster-credential.sh"),
      ) as Step;
      expect(fetch.env, id).toEqual({
        DIGITALOCEAN_ACCESS_TOKEN: "${{ secrets.DIGITALOCEAN_TOKEN }}",
      });
      const last = job.steps.at(-1) as Step;
      expect(last.if, id).toBe("always()");
      expect(last.run, id).toContain('rm -f "$RUNNER_TEMP/kubeconfig"');
    }
    expect(script("cluster-credential.sh")).toContain(
      'doctl kubernetes cluster kubeconfig show "$CLUSTER_NAME" \\\n  --expiry-seconds "$CREDENTIAL_SECONDS"',
    );
  });

  it("keeps the repository's code out of the jobs that hold a credential", () => {
    for (const [id, job] of Object.entries(wf.jobs)) {
      const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.["persist-credentials"], id).toBe(false);
      const renders = job.steps.some((s) =>
        s.run?.includes("infra/kubernetes/render.ts"),
      );
      if (id === "render") {
        expect(job.environment).toBeUndefined();
        expect(renders).toBe(true);
        expect(JSON.stringify(job)).not.toMatch(SECRET_REFERENCE);
      } else {
        expect(renders, id).toBe(false);
        // The Secrets job reads the tunnel token from the factory stack, so it needs the stack.
        // The runner token job reads the Windmill host and workspace from the settings file.
        if (id === "runner-token") {
          expect(checkout?.with?.["sparse-checkout"], id).toBe(
            `/.github/\n/${SETTINGS_FILE}\n`,
          );
          expect(checkout?.with?.["sparse-checkout-cone-mode"], id).toBe(false);
        } else if (id !== "cluster-secrets") {
          expect(checkout?.with?.["sparse-checkout"], id).toBe(".github");
        }
      }
    }
  });

  it("applies the rendered objects the plan read, only when the plan has changes, then runs the checks", () => {
    const apply = wf.jobs.apply as Job;
    expect(apply.if).toContain("needs.plan.outputs.changed == 'true'");
    const runs = apply.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain(
      'kubectl apply --server-side --field-manager="$FIELD_MANAGER" --filename "$RUNNER_TEMP/render/manifests.json"',
    );
    expect(runs).toContain(
      'platform-checks.sh "$RUNNER_TEMP/render/manifests.json" all',
    );
    expect(
      apply.steps.find((s) => s.uses?.startsWith("actions/download-artifact@"))?.with
        ?.name,
    ).toBe("platform-manifests");
  });

  it("passes the API server's address from no job to another (D-349)", () => {
    for (const name of readdirSync(".github/workflows")) {
      const raw = text(join(".github/workflows", name));
      expect(raw, name).not.toMatch(/KUBERNETES_API|kubernetes-api|cluster-facts/);
    }
    expect(Object.keys(wf.jobs)).toEqual([
      "render",
      "plan",
      "apply",
      "cluster-secrets",
      "runner-token",
    ]);
    // The one job output is whether the plan found a change.
    const outputs = Object.fromEntries(
      Object.entries(wf.jobs)
        .filter(([, job]) => job.outputs !== undefined)
        .map(([id, job]) => [id, job.outputs]),
    );
    expect(outputs).toEqual({ plan: { changed: "${{ steps.diff.outputs.changed }}" } });
    expect(wf.jobs.render?.needs).toBeUndefined();
    expect(wf.jobs.plan?.needs).toBe("render");
    expect(wf.jobs.apply?.needs).toBe("plan");
    // The swap writes no output, environment or summary, so the address stays in its own step.
    expect(script("api-server-address.sh")).not.toMatch(
      /GITHUB_OUTPUT|GITHUB_ENV|GITHUB_STEP_SUMMARY/,
    );
  });

  it("renders with the placeholder only, the same one the swap looks for (D-349)", () => {
    const render = (wf.jobs.render as Job).steps.find((s) =>
      s.run?.includes("infra/kubernetes/render.ts"),
    ) as Step;
    expect(render.env).toBeUndefined();
    const set = [
      ...(render.run ?? "").matchAll(/\.platform\.kubernetesApi = (\{[^}]*\})/g),
    ];
    expect(set.map((m) => m[0])).toEqual([
      '.platform.kubernetesApi = {"addresses":["192.0.2.1"],"port":443}',
    ]);
    const placeholder = JSON.parse(set[0]?.[1] ?? "{}") as {
      addresses: string[];
      port: number;
    };
    expect(placeholder).toEqual(RENDER_PLACEHOLDER);
    const swapScript = script("api-server-address.sh");
    expect(swapScript).toContain(`placeholder_address="${placeholder.addresses[0]}"`);
    expect(swapScript).toContain(`placeholder_port=${placeholder.port}`);
    expect(script("platform-checks.sh")).toContain(
      `.host == "${placeholder.addresses[0]}"`,
    );
  });

  it("puts the address in right after the credential in each job that diffs or applies, in that job's own copy only", () => {
    const manifests = '"$RUNNER_TEMP/render/manifests.json"';
    for (const id of ["plan", "apply"]) {
      const steps = (wf.jobs[id] as Job).steps;
      const credential = steps.findIndex((s) =>
        s.run?.includes("cluster-credential.sh"),
      );
      const swap = steps.findIndex((s) => s.run?.includes("api-server-address.sh"));
      expect(swap, id).toBe(credential + 1);
      expect(steps[swap]?.env, id).toBeUndefined();
      expect(steps[swap]?.run, id).toBe(
        `set -euo pipefail\n.github/scripts/api-server-address.sh ${manifests}\n`,
      );
      // Nothing before the credential calls kubectl; everything after reads the swapped file.
      for (const step of steps.slice(0, credential))
        expect(step.run ?? "", `${id} ${step.name}`).not.toMatch(/kubectl|platform-/);
      expect(
        steps.some((s) => s.uses?.startsWith("actions/upload-artifact@")),
        id,
      ).toBe(false);
    }
    const plan = (wf.jobs.plan as Job).steps.map((s) => s.run ?? "").join("\n");
    expect(plan).toContain(`platform-plan.sh ${manifests}`);
    expect(
      wf.jobs["cluster-secrets"]?.steps.some((s) =>
        s.run?.includes("api-server-address.sh"),
      ),
    ).toBe(false);
  });

  it("sets the cluster's Secrets only when started by hand with cluster_secrets, after the apply", () => {
    const job = wf.jobs["cluster-secrets"] as Job;
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain("inputs.cluster_secrets");
    expect(job.needs).toEqual(["plan", "apply"]);
  });

  it("names the factory stack's cluster", () => {
    const variables = text("infra/stacks/factory/variables.tf");
    const block = variables.slice(variables.indexOf('variable "cluster_name"'));
    const name = /default\s*=\s*"([^"]+)"/.exec(block)?.[1];
    expect(wf.env?.CLUSTER_NAME).toBe(name);
    expect(wf.env?.SETTINGS_FILE).toBe(SETTINGS_FILE);
  });
});

describe("the cluster tools (unit: D-340)", () => {
  const tools = script("install-cluster-tools.sh");

  it("pins kubectl and doctl to exact versions with a sha256 each", () => {
    expect(tools).toMatch(/^KUBECTL_VERSION="v\d+\.\d+\.\d+"$/m);
    expect(tools).toMatch(/^KUBECTL_SHA256="[0-9a-f]{64}"$/m);
    expect(tools).toMatch(/^DOCTL_VERSION="\d+\.\d+\.\d+"$/m);
    expect(tools).toMatch(/^DOCTL_SHA256="[0-9a-f]{64}"$/m);
    expect(tools.match(/sha256sum --check --strict --quiet/g)).toHaveLength(2);
  });

  it("uses kubectl of the cluster's own minor version", () => {
    const kubectl = /^KUBECTL_VERSION="v(\d+\.\d+)\./m.exec(tools)?.[1];
    const cluster = /^kubernetes_version_prefix\s*=\s*"(\d+\.\d+)\."/m.exec(
      text("infra/stacks/factory/production.tfvars"),
    )?.[1];
    expect(kubectl).toBe(cluster);
  });
});

describe("the images workflow (unit: D-336)", () => {
  const build = script("build-images.sh");
  const images = [
    ...build.matchAll(/^\s+"(foreman-[a-z-]+)\s+(src\/\S+\/Dockerfile)"$/gm),
  ].map((m) => ({ name: m[1] as string, dockerfile: m[2] as string }));

  it("builds exactly the seven images first hosting needs, and not the Claude Code image or the sample service", () => {
    expect(images).toEqual([
      {
        name: "foreman-agent-opencode",
        dockerfile: "src/agent-images/opencode/Dockerfile",
      },
      {
        name: "foreman-agent-claude-api",
        dockerfile: "src/agent-images/claude-api/Dockerfile",
      },
      { name: "foreman-repo-map", dockerfile: "src/agent-images/repo-map/Dockerfile" },
      { name: "foreman-egress-proxy", dockerfile: "src/egress-proxy/Dockerfile" },
      { name: "foreman-state-api", dockerfile: "src/api/Dockerfile" },
      { name: "foreman-github-receiver", dockerfile: "src/github-receiver/Dockerfile" },
      { name: "foreman-run-watcher", dockerfile: "src/run-watcher/Dockerfile" },
    ]);
    for (const { dockerfile } of images)
      expect(existsSync(dockerfile), dockerfile).toBe(true);
  });

  it("builds every agent image a bot file dispatches", () => {
    const kinds = readdirSync("contracts/bots")
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => /^image:\s*(\S+)$/m.exec(text(join("contracts/bots", f)))?.[1])
      .filter((k): k is string => k !== undefined);
    expect([...new Set(kinds)].sort()).toEqual(["claude-api", "opencode"]);
    for (const kind of kinds) {
      expect(images.map((i) => i.dockerfile)).toContain(
        `src/agent-images/${kind}/Dockerfile`,
      );
    }
  });

  it("puts no secret into an image: no build argument, no build secret, no .env file", () => {
    for (const { dockerfile } of images) {
      const lines = text(dockerfile).split("\n");
      expect(
        lines.filter((l) => /^\s*ARG\s/i.test(l)),
        dockerfile,
      ).toEqual([]);
      expect(text(dockerfile), dockerfile).not.toMatch(
        /--mount=type=secret|--secret|--mount=type=ssh/,
      );
    }
    expect(build).not.toMatch(/--build-arg|--secret|--ssh/);
    const ignored = text(".dockerignore").split("\n");
    expect(ignored).toEqual(expect.arrayContaining([".env", ".env.*"]));
  });

  it("pushes to ghcr.io/didi-build with the job's own token only, signed in through stdin", () => {
    const wf = workflow(WORKFLOWS.images);
    const job = wf.jobs.build as Job;
    expect(job.env?.REGISTRY).toBe("ghcr.io/didi-build");
    expect(text(WORKFLOWS.images)).not.toMatch(SECRET_REFERENCE);
    const login = job.steps.find((s) => s.run?.includes("docker login")) as Step;
    expect(login.env?.REGISTRY_TOKEN).toBe("${{ github.token }}");
    expect(login.run).toContain("--password-stdin");
  });

  it("gives the settings file's image keys the images the settings file names", () => {
    const settings = committedSettings() as {
      platform: { images: Record<string, string> };
    };
    const expected: Record<string, string> = {
      stateApi: "foreman-state-api",
      receiver: "foreman-github-receiver",
      egressProxy: "foreman-egress-proxy",
      runWatcher: "foreman-run-watcher",
    };
    for (const [key, name] of Object.entries(expected)) {
      expect(build, key).toContain(`${key}: $r["${name}"]`);
      expect(settings.platform.images[key], key).toMatch(
        new RegExp(`^ghcr\\.io/didi-build/${name}@sha256:([0-9a-f]{64})?$`),
      );
    }
    expect(Object.keys(settings.platform.images).sort()).toEqual(
      Object.keys(expected).sort(),
    );
  });
});

describe("the settings file (unit: D-339, infra/kubernetes/settings/production.json)", () => {
  it("leaves the API server's address out (the jobs with the credential read it from the cluster)", () => {
    const settings = committedSettings() as { platform: Record<string, unknown> };
    expect(settings.platform).not.toHaveProperty("kubernetesApi");
  });

  it("holds no secret: no URL, token, password or key", () => {
    const raw = text(SETTINGS_FILE);
    expect(raw).not.toMatch(/:\/\/|token|password|secret|"key"/i);
  });

  it("renders into the cluster's objects once first hosting fills it in, with no Secret among them", () => {
    const objects = clusterObjects(filledSettings());
    expect(objects.items.length).toBeGreaterThan(10);
    expect(objects.items.some((o) => (o.kind as string) === "Secret")).toBe(false);
  });
});

describe("the cluster Secrets job (unit: D-339, runbook steps 9, 10 and 15)", () => {
  const table = [
    ...script("cluster-secrets.sh").matchAll(
      /^\s+"([a-z0-9-]+)\s+([a-z0-9]+)\s+([A-Z0-9_]+)\s+([a-z0-9-]+)"$/gm,
    ),
  ].map((m) => ({
    secret: m[1] as string,
    key: m[2] as string,
    variable: m[3] as string,
    deployment: m[4] as string,
  }));

  it("creates exactly the Secrets the platform pods read, each under its key", () => {
    expect(
      table
        .map(({ secret, key }) => ({ name: secret, key }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual(
      Object.values(PLATFORM_SECRETS)
        .map(({ name, key }) => ({ name, key }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  });

  it("restarts the deployment whose pods read each Secret", () => {
    const readers = new Map<string, Set<string>>();
    for (const o of renderedObjects().items) {
      if (o.kind !== "Deployment") continue;
      for (const container of o.spec.template.spec.containers) {
        for (const env of container.env) {
          const ref = (env as { valueFrom?: { secretKeyRef?: { name: string } } })
            .valueFrom?.secretKeyRef;
          if (ref)
            readers.set(
              ref.name,
              (readers.get(ref.name) ?? new Set()).add(o.metadata.name),
            );
        }
      }
    }
    for (const { secret, deployment } of table) {
      expect([...(readers.get(secret) ?? [])], secret).toEqual([deployment]);
    }
  });

  it("takes each value from the platform environment's secrets, the derived two from the job itself", () => {
    const job = workflow(WORKFLOWS.platform).jobs["cluster-secrets"] as Job;
    const step = job.steps.find((s) => s.run?.includes("cluster-secrets.sh")) as Step;
    const fromEnvironment = table
      .map((t) => t.variable)
      .filter((v) => v !== "RECEIVER_TUNNEL_TOKEN")
      .map((v) => (v === "PLANNING_TOKEN_SHA256" ? "PLANNING_TOKEN" : v));
    for (const variable of fromEnvironment) {
      expect(step.env?.[variable], variable).toBe(`\${{ secrets.${variable} }}`);
    }
    expect(Object.keys(step.env ?? {}).sort()).toEqual(
      [
        ...fromEnvironment,
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "TF_VAR_state_encryption_passphrase",
      ].sort(),
    );
    expect(script("cluster-secrets.sh")).toContain('--from-file="$key=/dev/stdin"');
    expect(script("cluster-secrets.sh")).not.toMatch(/--from-literal|--from-env-file/);
  });
});

describe("the runner token job (unit: D-352, O-110, runbook step 8)", () => {
  const wf = workflow(WORKFLOWS.platform);
  const job = wf.jobs["runner-token"] as Job;
  const runnerToken = script("runner-token.sh");

  it("runs only when started by hand on main with runner_token, after the plan and the apply, in the environment Didi approves", () => {
    expect(job.environment).toBe("platform");
    expect(job.needs).toEqual(["plan", "apply"]);
    // The same conditions as the cluster Secrets job, with its own box.
    expect(job.if).toBe(
      (wf.jobs["cluster-secrets"] as Job).if?.replace(
        "inputs.cluster_secrets",
        "inputs.runner_token",
      ),
    );
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain("inputs.runner_token");
    expect(job.if).toContain(
      "needs.plan.result == 'success' && (needs.apply.result == 'success' || needs.apply.result == 'skipped')",
    );
    expect(wf.on.workflow_dispatch?.inputs).toMatchObject({
      runner_token: {
        description:
          "Also write the runner's cluster token into Windmill (Didi approves)",
        type: "boolean",
        default: false,
      },
    });
    expect(Object.keys(wf.on)).not.toContain("pull_request");
    expect(Object.keys(wf.on)).not.toContain("pull_request_target");
  });

  it("gives the Windmill token to the one step that writes, and to nothing else", () => {
    const raw = text(WORKFLOWS.platform);
    expect(raw.match(/WINDMILL_RUNNER_RESOURCES_TOKEN/g)).toHaveLength(2);
    const write = job.steps.find((s) => s.run?.includes("runner-token.sh")) as Step;
    expect(write.env).toEqual({
      WINDMILL_RUNNER_RESOURCES_TOKEN: "${{ secrets.WINDMILL_RUNNER_RESOURCES_TOKEN }}",
    });
    expect(write.run).toBe("set -euo pipefail\n.github/scripts/runner-token.sh\n");
    // Right after the credential, and the credential removed last, whatever happened.
    const steps = job.steps;
    const credential = steps.findIndex((s) => s.run?.includes("cluster-credential.sh"));
    expect(steps.indexOf(write)).toBe(credential + 1);
    expect(steps.at(-1)).toEqual({
      name: "Remove the credential",
      if: "always()",
      run: 'set -euo pipefail\nrm -f "$RUNNER_TEMP/kubeconfig"\n',
    });
  });

  it("writes exactly the Windmill paths flows/windmill.yaml gives the values the runner reads, the token as its one secret variable (D-370)", () => {
    const description = parseYaml(text("flows/windmill.yaml")) as {
      resources: {
        secrets: { path: string; windmill_path?: string }[];
        values: { name: string; windmill_path?: string }[];
      };
    };
    const secretPath = (path: string) =>
      description.resources.secrets.find((entry) => entry.path === path)?.windmill_path;
    const valuePath = (name: string) =>
      description.resources.values.find((entry) => entry.name === name)?.windmill_path;
    const scriptValue = (name: string) =>
      new RegExp(`^${name}="([^"]+)"$`, "m").exec(runnerToken)?.[1];
    // The token is a secret (a secret variable), the endpoint and the CA certificate values.
    expect(scriptValue("token_path")).toBe(
      secretPath("platform/agent-cluster/runner-token"),
    );
    expect(scriptValue("endpoint_path")).toBe(valuePath("agent_cluster_endpoint"));
    expect(scriptValue("ca_path")).toBe(valuePath("agent_cluster_ca_certificate"));
    const writes = [...runnerToken.matchAll(/write_variable "\$(\w+)" (\w+)/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(writes).toEqual([
      ["token_path", "true"],
      ["endpoint_path", "false"],
      ["ca_path", "false"],
    ]);
    // Variables, never resources: no resource route, type or shape is left.
    expect(runnerToken).not.toMatch(/resources\/|resource_type|foreman_text|content:/);
    expect(text("flows/windmill.yaml")).not.toMatch(/foreman_text|"content"/);
  });

  it("asks for a Windmill token whose one scope is variables:write on exactly the script's three paths (runbook step 8, D-370)", () => {
    const runbook = text("docs/runbooks/first-hosting.md");
    const paths = ["token_path", "endpoint_path", "ca_path"].map(
      (name) => new RegExp(`^${name}="([^"]+)"$`, "m").exec(runnerToken)?.[1],
    );
    const step8 = runbook.slice(
      runbook.indexOf("## 8. The runner's cluster token"),
      runbook.indexOf("## 9. "),
    );
    const scopeLines = step8
      .split("\n")
      .filter((line) => line.includes("Check that the selected scopes read exactly"));
    expect(scopeLines).toHaveLength(1);
    expect(
      [...(scopeLines[0] ?? "").matchAll(/`(\w+:\w+:[^`]+)`/g)].map((m) => m[1]),
    ).toEqual([`variables:write:${paths.join(",")}`]);
    // The secrets table names the same scope for the same secret.
    const row = runbook
      .split("\n")
      .find(
        (line) =>
          line.startsWith("| `platform`") &&
          line.includes("WINDMILL_RUNNER_RESOURCES_TOKEN"),
      );
    expect(row).toContain("`variables:write`");
    // No step asks for a resources scope or writes the runner's values as resources: the old
    // resources scope is named once, where step 8 revokes the token that carries it.
    expect(runbook).not.toMatch(/resources\/create|foreman_text/);
    expect(
      runbook.split("\n").filter((line) => line.includes("resources:write")),
    ).toEqual([expect.stringMatching(/^5\. \*\*Revoke the old token\.\*\* /)]);
  });

  it("hands nothing to another job or the summary, and sends values only through stdin or a private file", () => {
    expect(job.outputs).toBeUndefined();
    expect(runnerToken).not.toMatch(/GITHUB_OUTPUT|GITHUB_ENV|GITHUB_STEP_SUMMARY/);
    expect(runnerToken).toContain("--data-binary @-");
    expect(runnerToken).toContain('--header @"$work/headers"');
    expect(runnerToken).toContain("--output /dev/null");
    // The one body is stdin, and a redirect is never followed with the token.
    expect(runnerToken.match(/--data\S* \S+/g)).toEqual(["--data-binary @-"]);
    expect(runnerToken).not.toMatch(/--location|\s-L\s/);
    expect(runnerToken).not.toMatch(/-H "Authorization|--header "Authorization/);
    expect(runnerToken).not.toMatch(/--arg \w+ "\$(token|endpoint|windmill_token)"/);
    // The existence check reads nothing from stdin, so a value can never reach it.
    expect(runnerToken).toMatch(/"\$api\/exists\/\$path" <\/dev\/null/);
  });
});

describe("the database migrations workflow (unit: D-362, O-115)", () => {
  const wf = workflow(WORKFLOWS.database);
  const job = wf.jobs.migrate as Job & { "runs-on"?: string };
  const withoutComments = (source: string) =>
    source
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
  const raw = text(WORKFLOWS.database);
  const migrateSh = script("db-migrate.sh");
  const migrateTs = text("src/adapters/store-postgres/migrate.ts");

  it("starts on a push to main that changes a migration, the job's own files or the CA certificate, or by hand, never on a pull request", () => {
    expect(wf.on).toEqual({
      push: {
        branches: ["main"],
        paths: [
          "db/migrations/**",
          ".github/workflows/db-migrate.yml",
          ".github/scripts/db-migrate.sh",
          SUPABASE_CA_PATH,
        ],
      },
      workflow_dispatch: null,
    });
    expect(raw).not.toMatch(/pull_request|workflow_run|schedule:/);
  });

  it("has one job, on main only, in the environment database Didi approves, with a time limit and only contents: read", () => {
    expect(wf.permissions).toEqual({});
    expect(Object.keys(wf.jobs)).toEqual(["migrate"]);
    expect(job.name).toBe("db-migrate");
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("database");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
    // The runner image whose PostgreSQL client O-115 read in GitHub's software list.
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(wf.concurrency).toEqual({
      group: "db-migrate",
      "cancel-in-progress": false,
    });
    expect(wf.env).toBeUndefined();
    expect(job.env).toBeUndefined();
    expect(job.outputs).toBeUndefined();
  });

  it("checks out only .github/, the migrations and the CA certificate, keeping no credential, and runs no npm, setup-node or repository code: only the protected script", () => {
    expect(job.steps.map((s) => s.uses ?? "run")).toEqual([
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "run",
    ]);
    expect(job.steps[0]?.with).toEqual({
      "persist-credentials": false,
      "sparse-checkout": `/.github/\n/db/migrations/\n/${SUPABASE_CA_PATH}\n`,
      "sparse-checkout-cone-mode": false,
    });
    expect(withoutComments(raw)).not.toMatch(
      /\b(npm|npx|node|setup-node|tsx|pnpm|yarn)\b/i,
    );
    const commands = (job.steps[1]?.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    // The script reads db/migrations when it is given no folder.
    expect(commands).toEqual([
      "set -euo pipefail",
      'export REPORT="$RUNNER_TEMP/db-migrate.md"',
      "status=0",
      ".github/scripts/db-migrate.sh || status=$?",
      'if [ -f "$REPORT" ]; then',
      'tee -a "$GITHUB_STEP_SUMMARY" <"$REPORT"',
      "fi",
      'exit "$status"',
    ]);
  });

  it("gives the connection string only to the step that runs the script, in its env, and no other workflow names it", () => {
    expect(job.steps[1]?.env).toEqual({
      MIGRATION_DATABASE_URL: "${{ secrets.MIGRATION_DATABASE_URL }}",
    });
    expect(job.steps[0]?.env).toBeUndefined();
    expect(raw.match(/\$\{\{[^}]*\}\}/g)).toEqual([
      "${{ secrets.MIGRATION_DATABASE_URL }}",
    ]);
    for (const name of readdirSync(".github/workflows")) {
      if (join(".github/workflows", name) === WORKFLOWS.database) continue;
      expect(text(join(".github/workflows", name)), name).not.toContain(
        "MIGRATION_DATABASE_URL",
      );
    }
  });

  it("runs only bash, coreutils, redact.sh and psql in the script, psql twice (the plain-text check, then the migrations) with no connection value as an argument", () => {
    const code = withoutComments(migrateSh);
    expect(code).not.toMatch(/\b(npm|npx|node|tsx|curl|wget|apt-get|pip)\b/);
    expect(code).not.toMatch(/^\s*(source|\.)\s/m);
    expect([...code.matchAll(/"\$here\/([^"]+)"/g)].map((m) => m[1])).toEqual([
      "redact.sh",
    ]);
    expect(code).not.toMatch(/GITHUB_OUTPUT|GITHUB_ENV|GITHUB_STEP_SUMMARY/);
    const starts = code.split("\n").filter((line) => /^\s*psql\s/.test(line));
    expect(starts).toEqual([
      '  psql -X -q -w -c "select 1" >/dev/null 2>"$work/check-err" </dev/null || check_status=$?',
      '  psql -X -q -w --set=ON_ERROR_STOP=1 -f "$work/migrate.psql" \\',
    ]);
  });

  it("checks that the database refuses a connection without TLS, with no password, before the migrations, which connect with verify-full only (D-364, O-118)", () => {
    const code = withoutComments(migrateSh);
    // Each psql command with the environment set in front of it.
    const commands = code
      .split(/\n(?=PGHOST=)/)
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf("</dev/null")));
    expect(commands).toHaveLength(2);
    const [check, migrate] = commands as [string, string];
    expect(check).toBe(
      [
        'PGHOST="$host" PGPORT="$port" PGUSER="$user" PGDATABASE="$database" \\',
        '  PGPASSFILE="$work/no-password-file" PGSSLMODE=disable PGGSSENCMODE=disable \\',
        "  PGCONNECT_TIMEOUT=30 PGAPPNAME=foreman-db-migrate-tls-check \\",
        '  psql -X -q -w -c "select 1" >/dev/null 2>"$work/check-err" ',
      ].join("\n"),
    );
    expect(check).not.toMatch(/PGPASSWORD|password"/);
    expect(migrate).toBe(
      [
        'PGHOST="$host" PGPORT="$port" PGUSER="$user" PGPASSWORD="$password" PGDATABASE="$database" \\',
        '  PGSSLMODE=verify-full PGSSLROOTCERT="$ca_file" PGGSSENCMODE=disable \\',
        "  PGCLIENTENCODING=UTF8 PGCONNECT_TIMEOUT=30 PGAPPNAME=foreman-db-migrate \\",
        '  psql -X -q -w --set=ON_ERROR_STOP=1 -f "$work/migrate.psql" \\',
        '  >"$work/out" 2>"$work/err" ',
      ].join("\n"),
    );
    expect(code.indexOf(check)).toBeLessThan(code.indexOf(migrate));
    expect([...code.matchAll(/PGSSLMODE=\S+/g)].map((m) => m[0])).toEqual([
      "PGSSLMODE=disable",
      "PGSSLMODE=verify-full",
    ]);
    // The run stops on the check's outcome before the migrations' psql.
    const between = code.slice(code.indexOf(check), code.indexOf(migrate));
    expect(between).toContain('if [ "$check_status" -eq 0 ]; then');
    expect(between).toContain('if [ "$asked_for_password" = true ]; then');
    expect(between).toContain(
      'if [ "$check_status" -ne 2 ] || [ "$refused" != true ] || [ "$other_server_error" = true ]; then',
    );
  });

  it("trusts only the CA certificate the services read, at its fixed path in the checkout, with no way to name another (O-118)", () => {
    const code = withoutComments(migrateSh);
    expect(code.match(/^ca_file=.*$/gm)).toEqual([`ca_file="${SUPABASE_CA_PATH}"`]);
    expect(code.match(/PGSSLROOTCERT=\S+/g)).toEqual(['PGSSLROOTCERT="$ca_file"']);
    // The script reads no variable of its environment but these (and bash's own two), so none
    // can name a CA or turn verification off; inherited PG* settings are unset before psql runs.
    const read = new Set(
      [...code.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map((m) => m[1] as string),
    );
    expect([...read].sort()).toEqual([
      "BASH_REMATCH",
      "BASH_SOURCE",
      "MIGRATION_DATABASE_URL",
      "REPORT",
      "RUNNER_TEMP",
    ]);
    // The workflow sets nothing for the step but the connection string.
    expect(job.steps[1]?.env).toEqual({
      MIGRATION_DATABASE_URL: "${{ secrets.MIGRATION_DATABASE_URL }}",
    });
    expect(raw).not.toMatch(
      /PGSSL|sslmode|sslrootcert|FOREMAN_LOCAL_DATABASE_WITHOUT_TLS/i,
    );
  });

  it("keeps migrate.ts's semantics: the same lock, file rule, order, setup and record row (test/db/db-migrate-script.test.ts runs both)", () => {
    const lock = /const MIGRATION_LOCK = ([\d_]+);/
      .exec(migrateTs)?.[1]
      ?.replaceAll("_", "");
    expect(lock).toBe("7104001");
    expect(migrateSh).toContain(`lock_id=${lock}\n`);
    const rule = /\.filter\(\(name\) => \/(.+)\/\.test\(name\)\)/.exec(migrateTs)?.[1];
    expect(rule).toBe("^\\d{4}_[a-z0-9_]+\\.sql$");
    expect(migrateSh).toContain(`name_rule='${rule?.replace("\\d", "[0-9]")}'\n`);
    // readMigrations sorts by UTF-16 code unit; for these ASCII names that is the C locale's order.
    expect(migrateTs).toMatch(/\.test\(name\)\)\s*\.sort\(\)/);
    expect(migrateSh).toContain("export LC_ALL=C\n");
    const words = (sql: string) => sql.replace(/\s+/g, " ").trim();
    const tsSetup = /await client\.query\(`([^`]*create schema[^`]*)`\)/.exec(
      migrateTs,
    )?.[1];
    const shSetup = /^setup_sql='([^']*)'$/m.exec(migrateSh)?.[1];
    expect(words(shSetup ?? "")).toBe(words(tsSetup ?? "-"));
    expect(words(shSetup ?? "")).toContain(
      "revoke all on schema factory_meta from public;",
    );
    expect(migrateTs).toContain(
      '"insert into factory_meta.schema_migrations (name, sha256) values ($1, $2)"',
    );
    expect(migrateSh).toContain(
      "insert into factory_meta.schema_migrations (name, sha256) values ('${names[i]}', '${shas[i]}');",
    );
    expect(MIGRATIONS_DIR).toBe("db/migrations");
    expect(migrateSh).toContain('migrations="${1:-db/migrations}"\n');
  });
});

describe("the Windmill deploy workflow (unit: D-371, O-123)", () => {
  const wf = workflow(WORKFLOWS.windmill);
  const bundle = wf.jobs.bundle as Job & { "runs-on"?: string };
  const deploy = wf.jobs.deploy as Job & { "runs-on"?: string };
  const raw = text(WORKFLOWS.windmill);
  const deploySh = script("windmill-deploy.sh");
  const code = deploySh
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  const description = parseYaml(text("flows/windmill.yaml")) as {
    flows: {
      name: string;
      path: string;
      trigger: string;
      job_token_scopes: string[];
    }[];
    resources: {
      secrets: { path: string; windmill_path?: string }[];
      values: { name: string; windmill_path?: string; written_by?: string }[];
      github_apps: {
        secrets: { windmill_path: string }[];
        values: { windmill_path: string }[];
      };
    };
  };
  /** The value names the deploy script writes, from its own list. */
  const scriptValues = [
    ...(/^value_names=\(\n([\s\S]*?)\n\)$/m.exec(deploySh)?.[1] ?? "").matchAll(
      /^\s+([a-z_]+)$/gm,
    ),
  ].map((m) => m[1]);

  it("starts on a push to main that changes what the flows use, or by hand, never on a pull request", () => {
    expect(wf.on).toEqual({
      push: {
        branches: ["main"],
        paths: [
          "flows/**",
          "src/**",
          "contracts/**",
          "package.json",
          "package-lock.json",
          "scripts/windmill-bundle.ts",
          "infra/kubernetes/platform.ts",
          PLATFORM_SETTINGS_FILE,
          AGENT_RUNS_FILE,
          WORKFLOWS.windmill,
          ".github/scripts/windmill-deploy.sh",
        ],
      },
      workflow_dispatch: null,
    });
    expect(raw).not.toMatch(/pull_request|workflow_run|schedule:/);
    // Waiting runs line up and the newest waiting one stands for them all (D-371).
    expect(wf.concurrency).toEqual({
      group: "windmill-deploy",
      "cancel-in-progress": false,
    });
    expect(wf.permissions).toEqual({});
    expect(wf.env).toEqual({ SETTINGS_FILE });
  });

  it("bundles in a job with no environment and no secret, the only job that runs the repository's code, and keeps the result one day", () => {
    expect(Object.keys(wf.jobs)).toEqual(["bundle", "deploy"]);
    expect(bundle.environment).toBeUndefined();
    expect(bundle.needs).toBeUndefined();
    expect(bundle.if).toBe("github.ref == 'refs/heads/main'");
    expect(bundle["runs-on"]).toBe("ubuntu-24.04");
    expect(JSON.stringify(bundle)).not.toMatch(SECRET_REFERENCE);
    expect(bundle.steps.map((s) => s.uses?.replace(/@.*/, "") ?? s.name)).toEqual([
      "actions/checkout",
      "actions/setup-node",
      "npm ci",
      "Bundle each flow entry and write the manifest",
      "actions/upload-artifact",
    ]);
    expect(bundle.steps[0]?.with).toEqual({ "persist-credentials": false });
    expect(bundle.steps[2]?.run).toBe("set -euo pipefail\nnpm ci --ignore-scripts\n");
    expect(bundle.steps[3]?.run).toContain(
      'node scripts/windmill-bundle.ts --commit "$GITHUB_SHA" --out "$RUNNER_TEMP/windmill-deploy"',
    );
    expect(bundle.steps[3]?.env).toBeUndefined();
    expect(bundle.steps[4]?.with).toEqual({
      name: "windmill-deploy",
      path: "${{ runner.temp }}/windmill-deploy",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    expect(bundle.outputs).toBeUndefined();
  });

  it("deploys in the environment windmill Didi approves, after the bundle, from .github/ and the settings file only, running no npm, node or repository code", () => {
    expect(deploy.environment).toBe("windmill");
    expect(deploy.needs).toBe("bundle");
    expect(deploy.if).toBe("github.ref == 'refs/heads/main'");
    expect(deploy.permissions).toEqual({ contents: "read" });
    expect(deploy["timeout-minutes"]).toBeLessThanOrEqual(30);
    expect(deploy.env).toBeUndefined();
    expect(deploy.outputs).toBeUndefined();
    expect(deploy.steps.map((s) => s.uses ?? "run")).toEqual([
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
      "run",
    ]);
    expect(deploy.steps[0]?.with).toEqual({
      "persist-credentials": false,
      "sparse-checkout": `/.github/\n/${SETTINGS_FILE}\n`,
      "sparse-checkout-cone-mode": false,
    });
    expect(deploy.steps[1]?.with).toEqual({
      name: bundle.steps[4]?.with?.name,
      path: "${{ runner.temp }}/windmill-deploy",
    });
    const commands = (deploy.steps[2]?.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(commands).toEqual([
      "set -euo pipefail",
      'export REPORT="$RUNNER_TEMP/windmill-deploy.md"',
      "status=0",
      '.github/scripts/windmill-deploy.sh "$RUNNER_TEMP/windmill-deploy" || status=$?',
      'if [ -f "$REPORT" ]; then',
      'tee -a "$GITHUB_STEP_SUMMARY" <"$REPORT"',
      "fi",
      'exit "$status"',
    ]);
    expect(JSON.stringify(deploy)).not.toMatch(/\b(npm|npx|node|setup-node|tsx)\b/);
  });

  it("gives WINDMILL_DEPLOY_TOKEN only to the step that runs the protected script, and no other workflow names it", () => {
    expect(deploy.steps[2]?.env).toEqual({
      WINDMILL_DEPLOY_TOKEN: "${{ secrets.WINDMILL_DEPLOY_TOKEN }}",
    });
    expect(raw.match(/\$\{\{[^}]*secrets\.[^}]*\}\}/g)).toEqual([
      "${{ secrets.WINDMILL_DEPLOY_TOKEN }}",
    ]);
    for (const name of readdirSync(".github/workflows")) {
      if (join(".github/workflows", name) === WORKFLOWS.windmill) continue;
      expect(text(join(".github/workflows", name)), name).not.toContain(
        "WINDMILL_DEPLOY_TOKEN",
      );
    }
  });

  it("runs only bash, coreutils, jq and curl, reads no setting of its environment but its own, and hands nothing on", () => {
    expect(code).not.toMatch(/\b(npm|npx|node|tsx|wget|python3?|apt-get|pip)\b/);
    // (jq's own `. as $m` is no shell source.)
    expect(code).not.toMatch(/^\s*(source\s|\.\s+["$./])/m);
    expect(code).not.toMatch(/GITHUB_OUTPUT|GITHUB_ENV|GITHUB_STEP_SUMMARY/);
    const read = new Set(
      [...code.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map((m) => m[1] as string),
    );
    expect([...read].sort()).toEqual([
      "REPORT",
      "RUNNER_TEMP",
      "SETTINGS_FILE",
      "WINDMILL_DEPLOY_TOKEN",
    ]);
  });

  it("sends the token in a private header file only, every body through a file or stdin, follows no redirect and never deletes", () => {
    expect(code).toContain(
      'printf \'Authorization: Bearer %s\\n\' "$token" >"$work/headers"',
    );
    expect(code.match(/--header @"\$work\/headers"/g)).toHaveLength(3);
    expect(code).not.toMatch(/-H "Authorization|--header "Authorization/);
    expect(code.match(/--data\S* \S+/g)).toEqual(["--data-binary @-"]);
    expect(code.match(/--form "[^"]+"/g)).toEqual([
      '--form "script=<$work/script.json;type=application/json"',
      '--form "file=@$dir/bundles/$name.js;type=application/javascript"',
    ]);
    // (`[ -L` tests for a symbolic link; a curl option would start its own line.)
    expect(code).not.toMatch(
      /--location|^\s+-L\s|--request (DELETE|PUT)|\/delete|archive/m,
    );
    expect(code).toMatch(/"\$api\/\$kind\/exists\/\$path" <\/dev\/null/);
    expect(code).toMatch(
      /"\$api\/scripts\/create_snapshot\?skip_if_noop=true" <\/dev\/null/,
    );
    // The routes it calls, and no other: no resource, flow, job, user or workspace route.
    const routes = [...code.matchAll(/\$api\/([a-z_/$?=]+)/g)].map((m) => m[1]);
    expect([...new Set(routes)].sort()).toEqual([
      "$kind/exists/$path",
      "schedules/create",
      "schedules/update/$path",
      "scripts/create_snapshot?skip_if_noop=true",
      "variables/create",
      "variables/update/$path",
    ]);
    expect(code).toContain('api="https://$host/api/w/$workspace"');
  });

  it("writes exactly the plain values flows/windmill.yaml leaves to it, each as a plain variable, never a secret one", () => {
    const leftToDeploy = description.resources.values
      .filter((v) => v.written_by === undefined)
      .map((v) => v.name);
    expect([...scriptValues].sort()).toEqual([...leftToDeploy].sort());
    expect(scriptValues).toEqual([...DEPLOYED_VALUES]);
    // None names a secret, or a value someone else writes.
    const elsewhere = [
      ...description.resources.secrets.map(
        (s) => s.windmill_path ?? `f/foreman/${s.path}`,
      ),
      ...description.resources.values
        .filter((v) => v.written_by !== undefined)
        .map((v) => v.windmill_path),
      ...description.resources.github_apps.secrets.map((s) => s.windmill_path),
      ...description.resources.github_apps.values.map((v) => v.windmill_path),
    ];
    for (const name of scriptValues)
      expect(elsewhere).not.toContain(`f/foreman/${name}`);
    expect(code).not.toMatch(/is_secret: true/);
    expect(code.match(/is_secret: [a-z$]+/g)).toEqual([
      "is_secret: false",
      "is_secret: false",
    ]);
  });

  it("allows each script only the job token scopes flows/windmill.yaml gives it (D-371, O-121)", () => {
    const every = /^every_script_scope='([^']+)'$/m.exec(deploySh)?.[1];
    const reconcileOnly = /^reconcile_only_scope='([^']+)'$/m.exec(deploySh)?.[1];
    expect(/^reconcile_path='([^']+)'$/m.exec(deploySh)?.[1]).toBe(
      "f/foreman/reconcile",
    );
    for (const flow of description.flows) {
      const allowed =
        flow.path === "f/foreman/reconcile" ? [every, reconcileOnly] : [every];
      expect(flow.job_token_scopes, flow.name).toEqual(allowed);
    }
  });

  it("asks for a token with exactly the three scopes of D-371, and the runbook names its environment and secret (runbook step 15)", () => {
    const runbook = text("docs/runbooks/first-hosting.md");
    const step15 = runbook.slice(
      runbook.indexOf("## 15. "),
      runbook.indexOf("\n## 16. "),
    );
    const scopeLines = step15
      .split("\n")
      .filter((line) => line.includes("Check that the selected scopes read exactly"));
    expect(scopeLines).toHaveLength(1);
    expect(
      [...(scopeLines[0] ?? "").matchAll(/`(\w+:\w+:[^`]+)`/g)].map((m) => m[1]),
    ).toEqual([
      "scripts:write:f/foreman/*",
      "schedules:write:f/foreman/*",
      `variables:write:${scriptValues.map((name) => `f/foreman/${name}`).join(",")}`,
    ]);
    const row = runbook
      .split("\n")
      .find(
        (line) =>
          line.startsWith("| `windmill`") && line.includes("WINDMILL_DEPLOY_TOKEN"),
      );
    expect(row).toContain("15");
    // The environment comes first, with its rules, as step 9a's does.
    expect(step15).toContain(
      "name it `windmill`. Required reviewers: Didi only. Deployment branches: Selected branches, `main` only.",
    );
  });
});

describe("the factory stack's reviewed variables (unit: ADR 0110 secrets rule 1)", () => {
  it("sets only declared, non-secret variables, and no id or host name", () => {
    const tfvars = text("infra/stacks/factory/production.tfvars");
    const names = [...tfvars.matchAll(/^([a-z_]+)\s*=/gm)].map((m) => m[1]);
    const declared = [
      ...text("infra/stacks/factory/variables.tf").matchAll(/variable "([a-z_]+)"/g),
    ].map((m) => m[1]);
    for (const name of names) expect(declared).toContain(name);
    for (const fromEnvironment of [
      "state_encryption_passphrase",
      "cloudflare_settings",
      "receiver_hostname",
    ]) {
      expect(names).not.toContain(fromEnvironment);
    }
    expect(tfvars).not.toMatch(/[0-9a-f]{32}|didi\.build/);
  });
});
