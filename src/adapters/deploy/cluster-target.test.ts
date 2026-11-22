// Seam: the cluster target (unit with a fake of the runner's workflow reads, ADR 0118 appendix G,
// D-441, D-449, O-166). Its deploy reads only the Images workflow's runs for the commit and the
// jobs of the newest one, through the core's `GitHubWorkflowReader`, and answers the release
// waiting for Didi's Platform apply or a fixed infrastructure refusal; it has no other port, so
// it cannot reach Cloudflare or the cluster. Setup and secrets refuse with fixed text. Synthetic
// runs and jobs; no network.
import { describe, expect, it } from "vitest";

import type {
  GitHubWorkflowReader,
  WorkflowJob,
  WorkflowRun,
} from "../../core/github.ts";
import type { Project } from "../../core/store.ts";
import {
  CLUSTER_REFUSALS,
  CLUSTER_TARGET_REFUSALS,
  IMAGES_JOB,
  IMAGES_WORKFLOW,
  createClusterTarget,
} from "./cluster-target.ts";

const REPO = "didi-build/foreman";
const COMMIT = "a".repeat(40);
const PROJECT = { slug: "foreman", repo: REPO, deployTarget: "cluster" } as Project;

const run = (id: number, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  path: IMAGES_WORKFLOW,
  event: "push",
  headSha: COMMIT,
  headRepo: REPO,
  ...extra,
});
const job = (runId: number, extra: Partial<WorkflowJob> = {}): WorkflowJob => ({
  id: runId * 10,
  runId,
  name: IMAGES_JOB,
  headSha: COMMIT,
  status: "completed",
  conclusion: "success",
  ...extra,
});

function fakeReads(
  runs: WorkflowRun[] | "throw",
  jobs: Record<number, WorkflowJob[]> = {},
) {
  const calls: string[] = [];
  const workflows: GitHubWorkflowReader = {
    async listWorkflowRuns(repo, file, sha) {
      calls.push(`runs ${repo} ${file} ${sha}`);
      if (runs === "throw") throw new Error("GitHub refused");
      return runs;
    },
    async listWorkflowJobs(repo, runId) {
      calls.push(`jobs ${repo} ${runId}`);
      return jobs[runId] ?? [];
    },
  };
  return { target: createClusterTarget({ workflows }), calls };
}

const refusal = (reason: keyof typeof CLUSTER_REFUSALS) => ({
  outcome: "refused",
  cause: "infrastructure",
  reason,
  text: CLUSTER_REFUSALS[reason],
});

describe("the cluster target (unit with fakes, O-166)", () => {
  it("answers that the commit's images were built and wait for the Platform apply, from the newest Images run's build job", async () => {
    const f = fakeReads([run(7), run(9), run(8)], {
      9: [job(9, { name: "something-else", conclusion: "failure" }), job(9)],
    });
    expect(await f.target.deploy({ project: PROJECT, commitSha: COMMIT })).toEqual({
      outcome: "awaiting_apply",
      images: { runId: 9 },
    });
    expect(f.calls).toEqual([`runs ${REPO} images.yml ${COMMIT}`, `jobs ${REPO} 9`]);
  });

  it("refuses with fixed infrastructure text when the run still builds, was cancelled, failed, is missing or cannot be read", async () => {
    const cases: [
      WorkflowRun[] | "throw",
      WorkflowJob[],
      keyof typeof CLUSTER_REFUSALS,
    ][] = [
      [
        [run(5)],
        [job(5, { status: "in_progress", conclusion: null })],
        "images_building",
      ],
      [[run(5)], [job(5, { status: "queued", conclusion: null })], "images_building"],
      [[run(5)], [job(5, { conclusion: "cancelled" })], "images_cancelled"],
      [[run(5)], [job(5, { conclusion: "failure" })], "images_failed"],
      [[run(5)], [job(5, { conclusion: "timed_out" })], "images_failed"],
      [[run(5)], [job(5, { conclusion: "skipped" })], "images_failed"],
      [[], [], "images_missing"],
      // Another workflow, another commit or another repository's run is not the Images run.
      [[run(5, { path: ".github/workflows/ci.yml" })], [job(5)], "images_missing"],
      [[run(5, { headSha: "b".repeat(40) })], [job(5)], "images_missing"],
      [[run(5, { headRepo: "didi-build/rehearsal" })], [job(5)], "images_missing"],
      [[run(5)], [], "images_unreadable"],
      [[run(5)], [job(5, { runId: 6 })], "images_unreadable"],
      ["throw", [], "images_unreadable"],
    ];
    for (const [runs, jobs, reason] of cases) {
      const f = fakeReads(runs, { 5: jobs });
      expect(
        await f.target.deploy({ project: PROJECT, commitSha: COMMIT }),
        `${reason}: ${JSON.stringify(jobs)}`,
      ).toEqual(refusal(reason));
    }
    // A commit that is not a full sha reads nothing.
    const bad = fakeReads([run(5)], { 5: [job(5)] });
    expect(await bad.target.deploy({ project: PROJECT, commitSha: "abc" })).toEqual(
      refusal("images_unreadable"),
    );
    expect(bad.calls).toEqual([]);
  });

  it("keeps every refusal's text fixed and within the daily check's 200 characters", () => {
    for (const text of [
      ...Object.values(CLUSTER_REFUSALS),
      ...Object.values(CLUSTER_TARGET_REFUSALS),
    ]) {
      expect(text.length).toBeLessThanOrEqual(200);
      // No em or en dash (AGENTS.md section 8).
      expect(text).not.toMatch(new RegExp(String.raw`[\u2014\u2013]`));
    }
  });

  it("sets nothing up and holds no product secret, reading nothing", async () => {
    const f = fakeReads("throw");
    expect(f.target.name).toBe("cluster");
    expect(
      await f.target.setUp({ slug: "foreman", displayName: "Foreman", purpose: "x" }),
    ).toEqual({
      outcome: "refused",
      step: "check",
      reason: "no_setup",
      text: CLUSTER_TARGET_REFUSALS.no_setup,
    });
    const noSecrets = {
      outcome: "refused",
      reason: "no_secrets",
      text: CLUSTER_TARGET_REFUSALS.no_secrets,
    };
    expect(await f.target.putSecret("foreman", "MADE_UP", "made-up-value")).toEqual(
      noSecrets,
    );
    expect(await f.target.listSecretNames("foreman")).toEqual(noSecrets);
    expect(f.calls).toEqual([]);
  });
});
