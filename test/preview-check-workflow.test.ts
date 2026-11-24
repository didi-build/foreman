// Seam: the workflow of CI's preview check (unit: repo guard, D-354, O-111). Read as YAML and
// text; nothing runs. The job is in CI's workflow, has its fixed name, runs on same-repository
// pull requests and on pushes to main with only contents read and no secret, builds and marks the
// PR's head commit (never the merge ref's), and serves and probes the build with the scripts in
// `.github/scripts/`. The hosted preview is gone. The scripts' behaviour is in
// test/preview-check-scripts.test.ts. On a push to main only, the same job keeps the build it
// probed as the artifact the runner's staging deploy fetches (D-353, O-116), and on a pull request
// only as the artifact `qa-site` the runner reads for QA's browser (ADR 0119 slice 5a, O-174),
// each with the upload-artifact pin the repository already uses, a short retention and still no
// secret. Nothing runs between the probe and the uploads.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { DEFAULT_PRIVILEGED_PATHS, globToRegExp } from "../src/core/guards/review.ts";
import {
  COMMIT_MARKER_FILE,
  PREVIEW_CHECK_JOB,
  PREVIEW_CHECK_WORKFLOW,
  PREVIEW_CHECK_WORKFLOW_FILE,
} from "../src/core/preview-check.ts";
import {
  QA_SITE_ARTIFACT,
  QA_SITE_PIPELINE_PATHS,
  QA_SITE_RETENTION_DAYS,
} from "../src/core/qa-site.ts";
import {
  STAGING_BUILD_WORKFLOW,
  STAGING_SITE_ARTIFACT,
} from "../src/core/staging-deploy.ts";

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: unknown;
}
interface Job {
  name?: string;
  if?: string;
  environment?: unknown;
  permissions?: unknown;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, { branches?: string[] } | null>;
  permissions: unknown;
  jobs: Record<string, Job>;
}

const text = readFileSync(PREVIEW_CHECK_WORKFLOW, "utf8");
const workflow = parseYaml(text) as Workflow;
const job = workflow.jobs[PREVIEW_CHECK_JOB]!;
const runs = job.steps.flatMap((step) => (step.run ? [step.run] : []));
const jobText = JSON.stringify(job);

/** The commit the job builds and marks: the PR's head on a pull request, the pushed commit on main. */
const COMMIT = "${{ github.event.pull_request.head.sha || github.sha }}";
/** The site root the host serves (wrangler.jsonc) and Vite builds into. */
const SITE = "dist/gallery";

describe("the preview check's workflow (unit: repo guard, D-354, O-111)", () => {
  it("is a job of CI's workflow under its fixed name", () => {
    expect(PREVIEW_CHECK_WORKFLOW).toBe(".github/workflows/ci.yml");
    expect(PREVIEW_CHECK_WORKFLOW.endsWith(`/${PREVIEW_CHECK_WORKFLOW_FILE}`)).toBe(
      true,
    );
    expect(job).toBeDefined();
    expect(job.name).toBe(PREVIEW_CHECK_JOB);
    expect(PREVIEW_CHECK_JOB).toBe("preview-check");
    // No other job of any workflow takes the name.
    for (const file of readdirSync(".github/workflows")) {
      const other = parseYaml(
        readFileSync(join(".github/workflows", file), "utf8"),
      ) as Workflow;
      for (const [id, each] of Object.entries(other.jobs)) {
        if (file === PREVIEW_CHECK_WORKFLOW_FILE && id === PREVIEW_CHECK_JOB) continue;
        expect(each.name ?? id, `${file} ${id}`).not.toBe(PREVIEW_CHECK_JOB);
      }
    }
  });

  it("runs on pull requests from the same repository and on pushes to main", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push"]);
    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(workflow.on.pull_request).toBeNull();
    expect(job.if).toBe(
      "github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  it("has only contents read and no secret, token or environment", () => {
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
    expect(jobText).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN/);
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("builds and marks the PR's head commit, never the merge ref's", () => {
    expect(job.env?.COMMIT_SHA).toBe(COMMIT);
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe(COMMIT);
    expect(jobText).not.toMatch(/merge_commit_sha|refs\/pull|github\.ref\b/);
    // Every step reads the commit from COMMIT_SHA only.
    for (const run of runs) expect(run).not.toMatch(/\$\{\{/);
  });

  it("installs, builds, writes the marker into the site, then serves and probes it on one port", () => {
    const at = (pattern: RegExp) => runs.findIndex((run) => pattern.test(run));
    const install = at(/^npm ci$/);
    const build = at(/^npm run build$/);
    const marker = at(/preview-check\.mjs marker /);
    const probe = at(/preview-check\.mjs probe /);
    expect([install, build, marker, probe].every((i) => i >= 0)).toBe(true);
    expect(install < build && build < marker && marker < probe).toBe(true);

    expect(runs[marker]).toBe(
      `node .github/scripts/preview-check.mjs marker ${SITE} "$COMMIT_SHA"`,
    );
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    expect(wrangler).toContain(`"directory": "./${SITE}"`);
    expect(readFileSync("vite.config.ts", "utf8")).toContain(`outDir: "../${SITE}"`);

    const serveAndProbe = runs[probe]!.split("\n");
    expect(serveAndProbe[0]).toBe("set -euo pipefail");
    expect(serveAndProbe).toContain(
      `node .github/scripts/serve-site.mjs ${SITE} "$SITE_PORT" &`,
    );
    expect(serveAndProbe).toContain(
      'node .github/scripts/preview-check.mjs probe "http://127.0.0.1:${SITE_PORT}" "$COMMIT_SHA"',
    );
    expect(job.env?.SITE_PORT).toMatch(/^\d{4,5}$/);
  });

  it("uses only actions pinned as the rest of CI pins them, and the repository's upload pin", () => {
    const pins = workflow.jobs.check!.steps.flatMap((s) => (s.uses ? [s.uses] : []));
    const used = job.steps.flatMap((s) => (s.uses ? [s.uses] : []));
    expect(used).toHaveLength(4);
    for (const uses of used.slice(0, 2)) expect(pins, uses).toContain(uses);
    expect(used.slice(2)).toEqual([UPLOAD_PIN, UPLOAD_PIN]);
  });

  it("keeps the workflow and the scripts on privileged paths", () => {
    const patterns = DEFAULT_PRIVILEGED_PATHS.map(globToRegExp);
    for (const path of [
      PREVIEW_CHECK_WORKFLOW,
      ".github/scripts/serve-site.mjs",
      ".github/scripts/preview-check.mjs",
    ]) {
      expect(
        patterns.some((re) => re.test(path)),
        path,
      ).toBe(true);
    }
  });
});

/** The one upload-artifact pin the repository's other workflows already use. */
const UPLOAD_PIN = (() => {
  const found = new Set<string>();
  for (const file of readdirSync(".github/workflows")) {
    if (file === PREVIEW_CHECK_WORKFLOW_FILE) continue;
    const raw = readFileSync(join(".github/workflows", file), "utf8");
    for (const m of raw.matchAll(
      /uses: (actions\/upload-artifact@[0-9a-f]{40}) # v[\d.]+/g,
    ))
      found.add(m[1]!);
  }
  if (found.size !== 1)
    throw new Error("expected one upload-artifact pin in the repository");
  return [...found][0]!;
})();

/** The index of the job's upload step that keeps the artifact `name`. */
const uploadOf = (name: string) =>
  job.steps.findIndex(
    (s) => s.uses?.startsWith("actions/upload-artifact@") && s.with?.name === name,
  );

/** The step that serves and probes the build. */
const probeStep = job.steps.findIndex((s) =>
  /preview-check\.mjs probe /.test(s.run ?? ""),
);

describe("the probed build's artifacts (unit: repo guard, D-353, O-116, O-174)", () => {
  it("runs nothing between the probe and the uploads, so what is kept is what the probe served", () => {
    expect(probeStep).toBeGreaterThan(0);
    const after = job.steps.slice(probeStep + 1);
    expect(after.map((s) => s.with?.name)).toEqual([
      STAGING_SITE_ARTIFACT,
      QA_SITE_ARTIFACT,
    ]);
    for (const step of after) {
      expect(step.uses).toBe(UPLOAD_PIN);
      expect(step.run).toBeUndefined();
    }
    expect(probeStep + 2).toBe(job.steps.length - 1);
  });
});

describe("the staging site artifact (unit: repo guard, D-353, O-116)", () => {
  const index = uploadOf(STAGING_SITE_ARTIFACT);
  const upload = job.steps[index]!;

  it("keeps the probed build as staging-site, after the probe, with the repository's pin", () => {
    expect(STAGING_BUILD_WORKFLOW).toBe(PREVIEW_CHECK_WORKFLOW);
    expect(STAGING_SITE_ARTIFACT).toBe("staging-site");
    expect(upload.uses).toBe(UPLOAD_PIN);
    expect(text).toContain(`uses: ${UPLOAD_PIN} # v4.6.2`);
    expect(upload.with?.name).toBe(STAGING_SITE_ARTIFACT);
    expect(upload.with?.path).toBe(`${SITE}/`);
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    // Right after the probe: what is kept is exactly the site the probe served, marker included.
    expect(index).toBe(probeStep + 1);
    expect(COMMIT_MARKER_FILE).toBe("foreman-commit.txt");
  });

  it("runs on a push to main only, never on a pull request", () => {
    expect(upload.if).toBe("github.event_name == 'push'");
    // The workflow's only push is to main, and the job's own condition lets a push through.
    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(upload["continue-on-error"]).toBeUndefined();
  });

  it("keeps it for a short time, with no secret, token or environment", () => {
    expect(upload.with?.["retention-days"]).toBe(7);
    expect(Object.keys(upload.with ?? {}).sort()).toEqual([
      "if-no-files-found",
      "name",
      "path",
      "retention-days",
    ]);
    expect(JSON.stringify(upload)).not.toMatch(
      /secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN/,
    );
    expect(upload.env).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
  });
});

describe("the QA site artifact (unit: repo guard, ADR 0119 slice 5a, D-476 to D-480, O-174)", () => {
  const index = uploadOf(QA_SITE_ARTIFACT);
  const upload = job.steps[index]!;

  it("keeps the probed build as qa-site, marker included, after the probe, with the repository's pin", () => {
    expect(QA_SITE_ARTIFACT).toBe("qa-site");
    expect(index).toBeGreaterThan(probeStep);
    expect(upload.name).toBe("Keep the probed build for QA's browser");
    expect(upload.uses).toBe(UPLOAD_PIN);
    // The same folder the marker step wrote the head commit's marker into and the probe served.
    expect(upload.with?.path).toBe(`${SITE}/`);
    expect(runs).toContain(
      `node .github/scripts/preview-check.mjs marker ${SITE} "$COMMIT_SHA"`,
    );
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });

  it("runs on a pull request only, never on a push", () => {
    expect(upload.if).toBe("github.event_name == 'pull_request'");
    // The job's own condition lets only a pull request from the same repository through.
    expect(job.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(upload["continue-on-error"]).toBeUndefined();
  });

  it("keeps it for 3 days, with no secret, token or environment", () => {
    expect(QA_SITE_RETENTION_DAYS).toBe(3);
    expect(upload.with?.["retention-days"]).toBe(QA_SITE_RETENTION_DAYS);
    expect(Object.keys(upload.with ?? {}).sort()).toEqual([
      "if-no-files-found",
      "name",
      "path",
      "retention-days",
    ]);
    expect(JSON.stringify(upload)).not.toMatch(
      /secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN/,
    );
    expect(upload.env).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
  });

  it("names in the pipeline rule exactly this workflow and the scripts the job runs", () => {
    const scripts = new Set(
      runs.flatMap((run) =>
        [...run.matchAll(/\.github\/scripts\/[\w.-]+/g)].map((m) => m[0]),
      ),
    );
    expect([...scripts].sort()).toEqual([
      ".github/scripts/preview-check.mjs",
      ".github/scripts/serve-site.mjs",
    ]);
    expect([...QA_SITE_PIPELINE_PATHS].sort()).toEqual(
      [PREVIEW_CHECK_WORKFLOW, ...scripts].sort(),
    );
    for (const path of QA_SITE_PIPELINE_PATHS)
      expect(existsSync(path), path).toBe(true);
  });
});

describe("the hosted preview is gone (unit: repo guard, D-354)", () => {
  it("has no preview workflow, preview Worker or preview token", () => {
    expect(existsSync(".github/workflows/preview.yml")).toBe(false);
    expect(existsSync("wrangler.preview.jsonc")).toBe(false);
    for (const file of readdirSync(".github/workflows")) {
      const raw = readFileSync(join(".github/workflows", file), "utf8");
      expect(raw, file).not.toMatch(/wrangler preview|CLOUDFLARE_API_TOKEN_PREVIEW/);
    }
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["preview-workflow"]).toBeUndefined();
    expect(pkg.scripts.check).not.toContain("preview");
    expect(pkg.scripts.build).toBe("vite build");
  });
});
