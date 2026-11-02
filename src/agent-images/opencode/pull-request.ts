// The run's pull request, opened in plain code by the wrapper after a successful run (N-44,
// D-235). The model pushes its branch with git (D-196); the wrapper then:
// 1. reads the branch on GitHub, so a run that pushed nothing fails visibly, and takes its head
//    commit from there;
// 2. reuses the open pull request whose head is that branch, if there is one: a fix round or a
//    resumed run continues the same branch, so it continues the same PR (O-41, `runBranch`);
// 3. otherwise opens one into the repository's default branch, with the run's GitHub token.
// The runner links the PR to the item from GitHub's own events, by its branch and its App author
// (src/core/github-ingest.ts), never from what this code reports. A merged or closed PR is never
// reused: after a merge the item's next round needs a new PR from the same branch.
import type { GitHubApi } from "./github.ts";

export interface RunPullRequest {
  number: number;
  /** Built from the repository and the number, not read from GitHub's answer. */
  url: string;
  /** The branch's head commit on GitHub when the PR was opened or reused. */
  headSha: string;
  /** True when an open PR for the branch already existed. */
  reused: boolean;
}

/** Why the PR step failed. Each text names the step and GitHub's status only. */
export type PullRequestProblem =
  | "github_unreachable"
  | "branch_not_pushed"
  | "github_refused"
  | "several_open_pull_requests"
  | "unexpected_answer";

export type PullRequestOutcome =
  | { ok: true; pullRequest: RunPullRequest }
  | { ok: false; problem: PullRequestProblem; text: string };

const SHA = /^[0-9a-f]{40}$/;
const MAX_TITLE = 200;
/** GitHub's body limit is 65,536 characters. */
export const MAX_BODY = 60_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A branch as path segments: each segment encoded, the `/` between them kept. */
const branchPath = (branch: string): string =>
  branch.split("/").map(encodeURIComponent).join("/");

const fail = (
  problem: PullRequestProblem,
  text: string,
): { ok: false; problem: PullRequestProblem; text: string } => ({
  ok: false,
  problem,
  text,
});

function refused(step: string, status: number | null) {
  return status === null
    ? fail(
        "github_unreachable",
        `GitHub could not be reached through the egress proxy while ${step}`,
      )
    : fail("github_refused", `GitHub answered ${status} while ${step}`);
}

/** The open PRs whose head is exactly this branch of this repository. */
function openPullsFor(
  body: unknown,
  repository: string,
  branch: string,
): number[] | null {
  if (!Array.isArray(body)) return null;
  const numbers: number[] = [];
  for (const pull of body) {
    if (!isObject(pull) || !isNumber(pull.number) || !isObject(pull.head)) return null;
    const repo = isObject(pull.head.repo) ? pull.head.repo.full_name : undefined;
    if (pull.state === "open" && pull.head.ref === branch && repo === repository) {
      numbers.push(pull.number);
    }
  }
  return numbers;
}

/** Opens the run's PR, or reuses the open one for its branch. Never opens a second. */
export async function openOrReusePullRequest(options: {
  github: GitHubApi;
  /** `owner/name`. */
  repository: string;
  branch: string;
  title: string;
  body: string;
}): Promise<PullRequestOutcome> {
  const { github, repository, branch } = options;
  const [owner] = repository.split("/");
  const repo = `/repos/${repository}`;

  const ref = await github("GET", `${repo}/branches/${branchPath(branch)}`);
  if (ref.status === 404) {
    return fail(
      "branch_not_pushed",
      "the run's branch is not on GitHub: nothing was pushed",
    );
  }
  if (ref.status !== 200) return refused("reading the run's branch", ref.status);
  const commit =
    isObject(ref.body) && isObject(ref.body.commit) ? ref.body.commit.sha : null;
  if (typeof commit !== "string" || !SHA.test(commit)) {
    return fail(
      "unexpected_answer",
      "GitHub's answer for the run's branch has no head commit",
    );
  }
  const url = (number: number) => `https://github.com/${repository}/pull/${number}`;
  const reuse = (number: number): PullRequestOutcome => ({
    ok: true,
    pullRequest: { number, url: url(number), headSha: commit, reused: true },
  });

  const findOpen = async (): Promise<PullRequestOutcome | number[]> => {
    const head = encodeURIComponent(`${owner}:${branch}`);
    const listed = await github(
      "GET",
      `${repo}/pulls?state=open&head=${head}&per_page=100`,
    );
    if (listed.status !== 200)
      return refused("listing the branch's pull requests", listed.status);
    const numbers = openPullsFor(listed.body, repository, branch);
    if (numbers === null) {
      return fail(
        "unexpected_answer",
        "GitHub's list of pull requests is not in the expected shape",
      );
    }
    if (numbers.length > 1) {
      return fail(
        "several_open_pull_requests",
        "more than one open pull request has the run's branch as its head",
      );
    }
    return numbers;
  };

  const found = await findOpen();
  if (!Array.isArray(found)) return found;
  if (found.length === 1) return reuse(found[0] as number);

  const about = await github("GET", repo);
  if (about.status !== 200) return refused("reading the repository", about.status);
  const base = isObject(about.body) ? about.body.default_branch : null;
  if (typeof base !== "string" || base === "") {
    return fail(
      "unexpected_answer",
      "GitHub's answer for the repository has no default branch",
    );
  }
  const created = await github("POST", `${repo}/pulls`, {
    title: options.title.slice(0, MAX_TITLE),
    head: branch,
    base,
    body: options.body.slice(0, MAX_BODY),
  });
  if (created.status === 201) {
    const number = isObject(created.body) ? created.body.number : null;
    if (!isNumber(number)) {
      return fail(
        "unexpected_answer",
        "GitHub's answer for the new pull request has no number",
      );
    }
    return {
      ok: true,
      pullRequest: { number, url: url(number), headSha: commit, reused: false },
    };
  }
  if (created.status === 422) {
    // Most often a PR for this head was opened since the list was read: reuse it.
    const again = await findOpen();
    if (!Array.isArray(again)) return again;
    if (again.length === 1) return reuse(again[0] as number);
  }
  return refused("opening the pull request", created.status);
}
