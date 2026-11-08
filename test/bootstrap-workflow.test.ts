// Unit: repo guard on the Bootstrap workflow's shape (D-358 lock 1, O-113), read as YAML; nothing
// runs. Three jobs in order: decide (a protected script), prepare (the template's setup, without
// the token) and apply (a fresh runner that runs only .github/scripts/, the token only on the
// push and the settings steps). The scripts' behaviour is in bootstrap-plan, bootstrap-apply and
// bootstrap-settings tests; the isolation check's rules in check-bootstrap-isolation.test.ts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

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
  "runs-on"?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: unknown;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  env?: unknown;
  jobs: Record<string, Job>;
}

const WORKFLOWS_DIR = ".github/workflows";
const text = (name: string) => readFileSync(join(WORKFLOWS_DIR, name), "utf8");
const wf = parseYaml(text("bootstrap.yml")) as Workflow;
const { decide, prepare, apply } = wf.jobs as Record<
  "decide" | "prepare" | "apply",
  Job
>;
const TOKEN = "${{ secrets.BOOTSTRAP_TOKEN }}";
const namesToken = (value: unknown) =>
  JSON.stringify(value).includes("BOOTSTRAP_TOKEN");
const uses = (job: Job, action: string) =>
  job.steps.filter((step) => step.uses?.startsWith(`${action}@`));

describe("the Bootstrap workflow (unit: repo guard, D-358 lock 1)", () => {
  it("runs on a push to main and by hand (the register form restarts it with workflow_dispatch)", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect((wf.on.push as { branches: string[] }).branches).toEqual(["main"]);
    expect(wf.concurrency).toEqual({ group: "bootstrap", "cancel-in-progress": false });
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(wf.env).toBeUndefined();
  });

  it("has three jobs in order: decide, prepare without the token, apply with it", () => {
    expect(Object.keys(wf.jobs)).toEqual(["decide", "prepare", "apply"]);
    expect(decide.needs).toBeUndefined();
    expect(prepare.needs).toBe("decide");
    expect(apply.needs).toEqual(["decide", "prepare"]);
    for (const job of [decide, prepare, apply]) {
      expect(job["runs-on"]).toBe("ubuntu-latest");
      expect(job.permissions).toEqual({ contents: "read" });
      expect(job.env).toBeUndefined();
    }
    expect(decide.if).toBe("github.repository != 'didi-build/launchpad'");
  });

  it("decides first, with only the protected plan script, from the default branch", () => {
    expect(decide.steps).toHaveLength(2);
    const [checkout, plan] = decide.steps;
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout.with).toEqual({
      ref: "${{ github.event.repository.default_branch }}",
      "persist-credentials": false,
    });
    expect(plan.id).toBe("plan");
    expect(plan.run).toBe("node .github/scripts/bootstrap-plan.mjs");
    // It only asks whether the token is set; the value never reaches it.
    expect(plan.env?.HAS_BOOTSTRAP_TOKEN).toBe("${{ secrets.BOOTSTRAP_TOKEN != '' }}");
    expect(Object.values(plan.env ?? {}).filter(namesToken)).toHaveLength(1);
    expect(plan.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(plan.env?.LAUNCHPAD_COLLECTS_PERSONAL_DATA).toBe(
      "${{ vars.LAUNCHPAD_COLLECTS_PERSONAL_DATA || 'true' }}",
    );
    for (const key of [
      "execute",
      "init",
      "settings",
      "sha",
      "slug",
      "purpose",
      "personal_data",
    ]) {
      expect(decide.outputs?.[key]).toBe(`\${{ steps.plan.outputs.${key} }}`);
    }
  });

  it("prepares without the token: the template's setup runs there and hands a patch over", () => {
    expect(namesToken(prepare)).toBe(false);
    expect(JSON.stringify(prepare)).not.toMatch(/secrets\./);
    expect(prepare.if).toBe(
      "needs.decide.outputs.execute == 'true' && needs.decide.outputs.init == 'true'",
    );
    const [checkout] = uses(prepare, "actions/checkout");
    expect(checkout.with).toEqual({
      ref: "${{ needs.decide.outputs.sha }}",
      "persist-credentials": false,
    });
    const install = prepare.steps.find((s) => s.run?.includes("npm ci")) as Step;
    expect(install.run).toBe("npm ci --ignore-scripts");
    expect(install.if).toBe("needs.decide.outputs.personal_data == 'true'");
    const init = prepare.steps.find((s) => s.run?.includes("init-project")) as Step;
    expect(init.run).toBe(
      'node scripts/init-project.mjs "$PROJECT_SLUG" "$PROJECT_NAME" "$PROJECT_PURPOSE" "$PROJECT_OWNER"',
    );
    expect(init.env?.LAUNCHPAD_COLLECTS_PERSONAL_DATA).toBe(
      "${{ needs.decide.outputs.personal_data }}",
    );
    const patch = prepare.steps.find((s) => s.run?.includes("git diff")) as Step;
    expect(patch.run).toContain("git add -A");
    expect(patch.run).toContain(
      'git diff --cached --binary --no-renames --no-ext-diff --no-textconv > "$RUNNER_TEMP/bootstrap.patch"',
    );
    const [upload] = uses(prepare, "actions/upload-artifact");
    expect(upload.with).toMatchObject({
      name: "bootstrap-patch",
      path: "${{ runner.temp }}/bootstrap.patch",
      "if-no-files-found": "error",
    });
  });

  it("applies on a fresh runner only after a successful decision, and after prepare when init runs", () => {
    expect(apply.if).toBe(
      "${{ !cancelled() && needs.decide.result == 'success' && needs.decide.outputs.execute == 'true' && (needs.prepare.result == 'success' || (needs.prepare.result == 'skipped' && needs.decide.outputs.init != 'true')) }}",
    );
    expect(apply.steps.map((s) => s.uses?.split("@")[0] ?? s.run)).toEqual([
      "actions/checkout",
      "actions/download-artifact",
      'node .github/scripts/bootstrap-commit.mjs "$RUNNER_TEMP/bootstrap-patch/bootstrap.patch"',
      "node .github/scripts/bootstrap-push.mjs",
      'node .github/scripts/bootstrap-settings.mjs --apply --verify "$DEFAULT_BRANCH"',
    ]);
    const [checkout] = uses(apply, "actions/checkout");
    expect(checkout.with).toEqual({
      ref: "${{ needs.decide.outputs.sha }}",
      "persist-credentials": false,
    });
    const [download] = uses(apply, "actions/download-artifact");
    expect(download.with).toEqual({
      name: "bootstrap-patch",
      path: "${{ runner.temp }}/bootstrap-patch",
    });
  });

  it("gives the token only to the push and the settings steps, through their env", () => {
    const withToken = apply.steps.filter(namesToken);
    expect(withToken.map((s) => s.run)).toEqual([
      "node .github/scripts/bootstrap-push.mjs",
      'node .github/scripts/bootstrap-settings.mjs --apply --verify "$DEFAULT_BRANCH"',
    ]);
    for (const step of withToken) {
      expect(step.env).toEqual({
        GH_TOKEN: TOKEN,
        DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
      });
      expect(step.uses).toBeUndefined();
    }
    const commit = apply.steps.find((s) => s.id === "commit") as Step;
    expect(namesToken(commit)).toBe(false);
    expect(withToken[0].if).toBe("steps.commit.outputs.committed == 'true'");
    expect(withToken[1].if).toBe("needs.decide.outputs.settings == 'true'");
    // The secret is read in three places only: these two steps and the decide step's presence test.
    expect(text("bootstrap.yml").match(/secrets\.BOOTSTRAP_TOKEN/g)).toHaveLength(3);
  });

  it("runs no npm, npx or setup-node in the token job, and nothing outside .github/scripts/", () => {
    const raw = JSON.stringify(apply);
    expect(raw).not.toMatch(/\bnpm\b|\bnpx\b|setup-node|actions\/cache/);
    for (const step of apply.steps) {
      if (step.run !== undefined)
        expect(step.run).toMatch(/^node \.github\/scripts\/[a-z-]+\.mjs/);
    }
  });

  it("uses only action pins already in the repository", () => {
    const pinsElsewhere = new Set<string>();
    for (const name of readdirSync(WORKFLOWS_DIR)) {
      if (name === "bootstrap.yml" || name === "bootstrap-isolation.yml") continue;
      for (const match of text(name).matchAll(
        /uses:\s+(\S+@[0-9a-f]{40}\s+#\s+v[\d.]+)/g,
      )) {
        pinsElsewhere.add(match[1]);
      }
    }
    for (const name of ["bootstrap.yml", "bootstrap-isolation.yml"]) {
      const pins = [...text(name).matchAll(/uses:\s+(\S+@\S+\s+#\s+v[\d.]+)/g)].map(
        (m) => m[1],
      );
      expect(pins.length, name).toBeGreaterThan(0);
      expect(text(name).match(/uses:/g)?.length, name).toBe(pins.length);
      for (const pin of pins)
        expect(pinsElsewhere.has(pin), `${name} ${pin}`).toBe(true);
    }
  });
});

describe("the bootstrap isolation workflow (unit: repo guard)", () => {
  const iso = parseYaml(text("bootstrap-isolation.yml")) as Workflow;

  it("calls the check directly on every pull request and push to main, read-only", () => {
    expect(Object.keys(iso.on).sort()).toEqual(["pull_request", "push"]);
    expect((iso.on.push as { branches: string[] }).branches).toEqual(["main"]);
    expect(iso.permissions).toEqual({});
    expect(Object.keys(iso.jobs)).toEqual(["bootstrap-isolation"]);
    const job = iso.jobs["bootstrap-isolation"] as Job;
    // Not "check": that is the required status check's name.
    expect(job.name).toBe("bootstrap-isolation");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.steps).toHaveLength(2);
    expect(job.steps[0].with).toEqual({ "persist-credentials": false });
    expect(job.steps[1].run).toBe("node .github/scripts/check-bootstrap-isolation.mjs");
    expect(JSON.stringify(iso.jobs)).not.toMatch(/\bnpm\b|\bnpx\b|secrets\./);
  });
});
