// Seam: the read of the add-only apply jobs on GitHub's REST API (unit with fakes, D-378, D-444,
// O-158). A fake token port and a fake HTTP port stand in for the runner App and GitHub; the
// answers are synthetic JSON made here. The exact URLs and the one token they use (the runner
// App's `actions: read` token for `didi-build/foreman`), which runs are read further, which jobs
// are kept, and that every other answer throws. No network, no real run, id or token.
import { describe, expect, it } from "vitest";

import {
  addOnlyJobsOf,
  createGitHubAddOnlyApplies,
  runsToRead,
} from "./add-only-applies.ts";
import type {
  GitHubGetRequest,
  GitHubGetResponse,
  RunnerAppTokenRequest,
} from "./runner-app-tokens.ts";

const READ_TOKEN = "fake-read-token-not-real";
const SINCE = new Date("2026-11-20T06:00:00Z");

const encode = (body: unknown) =>
  new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
const ok = (body: unknown): GitHubGetResponse => ({ status: 200, body: encode(body) });

function fakes(answers: Record<string, GitHubGetResponse>, refuseMint = false) {
  const mints: RunnerAppTokenRequest[] = [];
  const gets: GitHubGetRequest[] = [];
  const applies = createGitHubAddOnlyApplies({
    tokens: {
      async mint(request) {
        mints.push(request);
        if (refuseMint) throw new Error("GitHub refused the token");
        return READ_TOKEN;
      },
    },
    http: {
      async get(request) {
        gets.push(request);
        return answers[request.path] ?? { status: 500, body: encode("") };
      },
    },
  });
  return { applies, mints, gets };
}

const run = (id: number, status: string, updated: string) => ({
  id,
  run_number: id + 100,
  status,
  updated_at: updated,
});
const job = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  status: "completed",
  conclusion: "success",
  created_at: "2026-11-20T10:00:00Z",
  started_at: "2026-11-20T10:01:00Z",
  completed_at: "2026-11-20T10:04:00Z",
  ...extra,
});
const RUNS = (file: string) =>
  `/repos/didi-build/foreman/actions/workflows/${file}/runs?branch=main&per_page=100`;
const JOBS = (id: number) =>
  `/repos/didi-build/foreman/actions/runs/${id}/jobs?filter=all&per_page=100`;

describe("the add-only apply jobs on GitHub (unit with fakes, O-158)", () => {
  it("reads the two workflows' runs and the jobs of those that may hold one, with one actions read token for didi-build/foreman", async () => {
    const f = fakes({
      [RUNS("platform.yml")]: ok({
        total_count: 3,
        workflow_runs: [
          run(3, "in_progress", "2026-11-20T11:00:00Z"),
          run(2, "completed", "2026-11-20T10:05:00Z"),
          // Completed before the window: no job in it can have ended in the window.
          run(1, "completed", "2026-11-19T10:05:00Z"),
        ],
      }),
      [RUNS("infra-apply.yml")]: ok({ total_count: 0, workflow_runs: [] }),
      [JOBS(3)]: ok({
        total_count: 2,
        jobs: [
          job("kubectl-diff"),
          job("kubectl-apply-add-only (seed-swap)", {
            status: "in_progress",
            conclusion: null,
            completed_at: null,
          }),
        ],
      }),
      [JOBS(2)]: ok({
        total_count: 3,
        jobs: [
          job("render"),
          job("kubectl-apply", { conclusion: "skipped" }),
          job("kubectl-apply-add-only (garden-notes)"),
        ],
      }),
    });
    expect(await f.applies.jobsSince(SINCE)).toEqual([
      {
        workflow: "platform",
        runNumber: 103,
        name: "kubectl-apply-add-only (seed-swap)",
        status: "in_progress",
        conclusion: null,
        startedAt: new Date("2026-11-20T10:01:00Z"),
        completedAt: null,
      },
      {
        workflow: "platform",
        runNumber: 102,
        name: "kubectl-apply-add-only (garden-notes)",
        status: "completed",
        conclusion: "success",
        startedAt: new Date("2026-11-20T10:01:00Z"),
        completedAt: new Date("2026-11-20T10:04:00Z"),
      },
    ]);
    expect(f.mints).toEqual([
      { repository: "didi-build/foreman", permission: "actions" },
    ]);
    expect(f.gets.map((g) => g.path)).toEqual([
      RUNS("platform.yml"),
      JOBS(3),
      JOBS(2),
      RUNS("infra-apply.yml"),
    ]);
    for (const g of f.gets) {
      expect(g).toMatchObject({ token: READ_TOKEN, accept: "json" });
    }
  });

  it("keeps only the workflow's own add-only job, by its name, with or without its projects", () => {
    const body = {
      total_count: 4,
      jobs: [
        job("tofu-apply"),
        job("tofu-apply-add-only (garden-notes)"),
        job("tofu-apply-add-only"),
        job("kubectl-apply-add-only (garden-notes)"),
      ],
    };
    expect(addOnlyJobsOf(body, "infra", 7).map((j) => j.name)).toEqual([
      "tofu-apply-add-only (garden-notes)",
      "tofu-apply-add-only",
    ]);
    // A job not started yet has no start time: its creation time stands in.
    expect(
      addOnlyJobsOf(
        {
          total_count: 1,
          jobs: [job("tofu-apply-add-only (a)", { started_at: null })],
        },
        "infra",
        7,
      )[0]?.startedAt,
    ).toEqual(new Date("2026-11-20T10:00:00Z"));
  });

  it("throws on a refused token, a refused call, an answer of another shape, a time that is not one, and more than it reads", async () => {
    await expect(fakes({}, true).applies.jobsSince(SINCE)).rejects.toThrow();
    for (const status of [401, 403, 404, 500]) {
      await expect(
        fakes({
          [RUNS("platform.yml")]: { status, body: encode({}) },
        }).applies.jobsSince(SINCE),
      ).rejects.toThrow();
    }
    expect(() => runsToRead({}, SINCE)).toThrow();
    expect(() => runsToRead({ workflow_runs: [{ id: 1 }] }, SINCE)).toThrow();
    expect(() =>
      runsToRead({ workflow_runs: [run(1, "completed", "yesterday")] }, SINCE),
    ).toThrow();
    const full = Array.from({ length: 100 }, (_, i) =>
      run(i + 1, "completed", "2026-11-20T10:05:00Z"),
    );
    expect(() => runsToRead({ workflow_runs: full }, SINCE)).toThrow(
      /more recent runs/,
    );
    expect(() => addOnlyJobsOf({ jobs: [] }, "platform", 1)).toThrow();
    expect(() =>
      addOnlyJobsOf({ total_count: 101, jobs: [] }, "platform", 1),
    ).toThrow();
    expect(() =>
      addOnlyJobsOf({ total_count: 1, jobs: [{ name: 3 }] }, "platform", 1),
    ).toThrow();
    expect(() =>
      addOnlyJobsOf(
        {
          total_count: 1,
          jobs: [job("kubectl-apply-add-only (a)", { completed_at: "soon" })],
        },
        "platform",
        1,
      ),
    ).toThrow();
  });
});
