// Seam: the runner's reads of CI's workflow runs and jobs (unit with fakes, D-354, D-267, O-111).
// Each read mints a read-only `actions` token for the one repository, asks GitHub's REST API for
// the one workflow file's runs on the commit or a run's jobs, and maps GitHub's fields, dropping an
// entry it cannot read. A fake token port and a fake HTTP port stand in for GitHub. No network, no
// real repository or token.
import { describe, expect, it } from "vitest";

import type {
  GitHubGetRequest,
  GitHubHttp,
  RunnerAppTokenRequest,
  RunnerAppTokens,
} from "./runner-app-tokens.ts";
import { GitHubReadError } from "./runner-app-tokens.ts";
import { createGitHubWorkflowReads } from "./workflow-runs.ts";

const REPO = "didi-build/rehearsal";
const HEAD = "b".repeat(40);
const TOKEN = "test-only-actions-token";

function fakes(answer: (path: string) => { status: number; body: unknown }) {
  const minted: RunnerAppTokenRequest[] = [];
  const requests: GitHubGetRequest[] = [];
  const tokens: RunnerAppTokens = {
    mint: async (request) => {
      minted.push(request);
      return TOKEN;
    },
  };
  const http: GitHubHttp = {
    get: async (request) => {
      requests.push(request);
      const { status, body } = answer(request.path);
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { status, body: new Uint8Array(Buffer.from(text)) };
    },
  };
  return { reads: createGitHubWorkflowReads({ tokens, http }), minted, requests };
}

const RUN = {
  id: 501,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  head_sha: HEAD,
  head_branch: "foreman/item-1",
  head_repository: { full_name: REPO },
  repository: { full_name: REPO },
  status: "completed",
  conclusion: "success",
};
const JOB = {
  id: 9001,
  run_id: 501,
  name: "preview-check",
  head_sha: HEAD,
  status: "completed",
  conclusion: "success",
  workflow_name: "CI",
};

describe("CI's workflow runs and jobs on GitHub (unit with fakes, D-267, O-111)", () => {
  it("lists one workflow file's runs on the commit with an actions read token for the repository", async () => {
    const f = fakes(() => ({
      status: 200,
      body: { total_count: 1, workflow_runs: [RUN] },
    }));
    expect(await f.reads.listWorkflowRuns(REPO, "ci.yml", HEAD)).toEqual([
      {
        id: 501,
        path: ".github/workflows/ci.yml",
        event: "pull_request",
        headSha: HEAD,
        headRepo: REPO,
      },
    ]);
    expect(f.minted).toEqual([{ repository: REPO, permission: "actions" }]);
    expect(f.requests).toEqual([
      {
        path: `/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&per_page=20`,
        token: TOKEN,
        accept: "json",
        maxBytes: 4 * 1024 * 1024,
      },
    ]);
  });

  it("lists a run's jobs from its latest attempt", async () => {
    const f = fakes(() => ({ status: 200, body: { total_count: 2, jobs: [JOB] } }));
    expect(await f.reads.listWorkflowJobs(REPO, 501)).toEqual([
      {
        id: 9001,
        runId: 501,
        name: "preview-check",
        headSha: HEAD,
        status: "completed",
        conclusion: "success",
      },
    ]);
    expect(f.minted).toEqual([{ repository: REPO, permission: "actions" }]);
    expect(f.requests.map((r) => r.path)).toEqual([
      `/repos/${REPO}/actions/runs/501/jobs?per_page=100`,
    ]);
  });

  it("keeps a job still running with no conclusion, and a fork's run with its own repository", async () => {
    const f = fakes((path) =>
      path.includes("/jobs")
        ? {
            status: 200,
            body: { jobs: [{ ...JOB, status: "in_progress", conclusion: null }] },
          }
        : {
            status: 200,
            body: {
              workflow_runs: [
                { ...RUN, head_repository: { full_name: "someone/rehearsal" } },
                { ...RUN, id: 502, head_repository: null },
              ],
            },
          },
    );
    expect(await f.reads.listWorkflowJobs(REPO, 501)).toMatchObject([
      { status: "in_progress", conclusion: null },
    ]);
    expect(
      (await f.reads.listWorkflowRuns(REPO, "ci.yml", HEAD)).map((r) => r.headRepo),
    ).toEqual(["someone/rehearsal", null]);
  });

  it("drops a run or job it cannot read, never guessing a field", async () => {
    const f = fakes((path) =>
      path.includes("/jobs")
        ? {
            status: 200,
            body: {
              jobs: [
                { ...JOB, id: "9001" },
                { ...JOB, run_id: undefined },
                { ...JOB, name: "" },
                { ...JOB, head_sha: "short" },
                { ...JOB, status: "Completed" },
                { ...JOB, conclusion: "Success!" },
                null,
                JOB,
              ],
            },
          }
        : {
            status: 200,
            body: {
              workflow_runs: [
                { ...RUN, id: -1 },
                { ...RUN, path: undefined },
                { ...RUN, event: 7 },
                { ...RUN, head_sha: HEAD.toUpperCase() },
                "not a run",
                RUN,
              ],
            },
          },
    );
    expect(await f.reads.listWorkflowJobs(REPO, 501)).toHaveLength(1);
    expect(await f.reads.listWorkflowRuns(REPO, "ci.yml", HEAD)).toHaveLength(1);
  });

  it("refuses a bad repository, workflow file, commit or run id before minting a token", async () => {
    const f = fakes(() => ({ status: 200, body: { workflow_runs: [], jobs: [] } }));
    await expect(
      f.reads.listWorkflowRuns("not a repo", "ci.yml", HEAD),
    ).rejects.toThrow(GitHubReadError);
    await expect(f.reads.listWorkflowRuns(REPO, "../ci.yml", HEAD)).rejects.toThrow(
      /workflow file/,
    );
    await expect(f.reads.listWorkflowRuns(REPO, "ci.yml", "main")).rejects.toThrow(
      /40-character sha/,
    );
    await expect(f.reads.listWorkflowJobs(REPO, 0)).rejects.toThrow(/run id/);
    expect(f.minted).toEqual([]);
  });

  it("names GitHub's status or a listing it cannot read, never the token", async () => {
    for (const [status, body, pattern] of [
      [404, { message: "Not Found" }, /listing the workflow runs failed with 404/],
      [200, "not json", /not JSON/],
      [200, { runs: [] }, /has no list/],
    ] as const) {
      const f = fakes(() => ({ status, body }));
      const error = await f.reads
        .listWorkflowRuns(REPO, "ci.yml", HEAD)
        .catch((e) => e);
      expect(error).toBeInstanceOf(GitHubReadError);
      expect(String(error.message)).toMatch(pattern);
      expect(String(error.message)).not.toContain(TOKEN);
    }
    const f = fakes(() => ({ status: 403, body: {} }));
    await expect(f.reads.listWorkflowJobs(REPO, 501)).rejects.toThrow(
      /listing the workflow jobs failed with 403/,
    );
  });
});
