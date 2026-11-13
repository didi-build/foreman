// The runner's own GitHub client (D-381, ADR 0113 sections 6 and 7, build plan M3.3, D-225): the
// core's `GitHub` (src/core/github.ts) over the runner App's narrow tokens, for the reconcile
// pass's polling backstop, the merge and the staging compare. Each call mints its own installation
// token for exactly the one repository of `didi-build` and the one permission it needs, uses it
// for that call (every page of one listing) and never keeps or logs it (O-125, D-346):
//
// - `getPullRequest`: `GET /repos/{repo}/pulls/{n}`, `pull_requests: read`. 404 is null.
// - `listChangedPaths`: `GET /repos/{repo}/pulls/{n}/files?per_page=100&page={p}`,
//   `pull_requests: read`, page by page until a short page. GitHub lists at most 3000 files of a
//   pull request, so a list that reaches 3000 may have been cut and is refused, never returned in
//   part: the privileged-path guard needs every path. A renamed file gives its new and its old
//   path, and a removed file its path, so a change that moves or deletes a file under a
//   privileged folder is seen.
// - `listCheckRuns`: `GET /repos/{repo}/commits/{sha}/check-runs` with
//   `?filter=latest&per_page=100&page={p}`, `checks: read`, page by page; 1000 or more runs are
//   refused, since the CI result needs all of them.
// - `listOpenPullRequests`: `GET /repos/{repo}/pulls?state=open&per_page=100&page={p}`,
//   `pull_requests: read`, page by page; 1000 or more are refused.
// - `listWorkflowRuns`, `listWorkflowJobs`: ./workflow-runs.ts, `actions: read` (D-267, O-111).
// - `getMergeability`: the pull request's `mergeable` and `head.sha`, `pull_requests: read`. 404
//   is null.
// - `squashMerge`: `PUT /repos/{repo}/pulls/{n}/merge` with exactly
//   `{"merge_method":"squash","sha":"<expected head>"}`, with the merge token's `contents: write`
//   (./merge-tokens.ts, D-365). 200 is merged, its `sha` the merge commit; 409 is `head_changed`;
//   405 is `not_mergeable`; anything else throws, and nothing is tried again.
// - `compareCommits`: `GET /repos/{repo}/compare/{base}...{head}?per_page=1`, `contents: read`,
//   GitHub's `status` as the relation. One commit per page keeps the answer small; the status is
//   for the whole comparison.
// - `getBranchHead`: `GET /repos/{repo}/branches/{branch}` with the name encoded,
//   `contents: read`, the branch's `commit.sha`. 404 is null.
//
// Strict: a repository outside `didi-build`, a number, sha or branch name the runner does not
// read is refused before any token is minted. An answer with another status, one that is not
// JSON, has a field missing or of another shape, or is for another pull request, repository or
// branch, throws a fixed-text error that names the step and at most GitHub's status code, never a
// token, a body, a path or a branch name. Nothing is dropped from a listing and nothing is guessed:
// one entry the runner cannot read refuses the whole listing. Not confirmed against GitHub until
// the first real call (O-127). The runner composes it with its App's token ports
// (flows/lib/compose.ts); tests pass fakes.
import {
  GITHUB_ORGANIZATION,
  organizationRepositoryName,
} from "../../core/bootstrap-access.ts";
import {
  REPOSITORY,
  type CheckRun,
  type CommitRelation,
  type GitHub,
  type PullRequest,
} from "../../core/github.ts";
import type { RunnerMergeTokens } from "./merge-tokens.ts";
import {
  GitHubReadError,
  type GitHubHttp,
  type RunnerAppTokens,
  type RunnerReadPermission,
} from "./runner-app-tokens.ts";
import { createGitHubWorkflowReads } from "./workflow-runs.ts";
import type { GitHubWriteHttp } from "./write-http.ts";

/** The most entries GitHub gives on one page, and what every listing asks for. */
export const PAGE_SIZE = 100;
/** GitHub lists at most 3000 files of a pull request: a list of 3000 may be cut. */
export const MAX_FILE_PAGES = 30;
/** The most pages of check runs on one commit the runner reads. */
export const MAX_CHECK_RUN_PAGES = 10;
/** The most pages of open pull requests in one repository the runner reads. */
export const MAX_OPEN_PULL_PAGES = 10;
/** The largest answer for one pull request or one branch. */
const MAX_OBJECT_BYTES = 1024 * 1024;
/** The largest page of a listing, and the largest compare, which lists up to 300 files. */
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
/** The largest merge answer. */
const MAX_MERGE_ANSWER_BYTES = 64 * 1024;

const FULL_SHA = /^[0-9a-f]{40}$/;
/** GitHub's conclusions are short lowercase words. */
const WORD = /^[a-z_]{1,40}$/;
/** The branch names the runner reads: letters, digits, `.`, `_`, `-` and `/` between parts. */
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;

/** GitHub's check run statuses. The last three only GitHub Actions sets, all before a run ends. */
const CHECK_STATUS: Readonly<Record<string, CheckRun["status"]>> = {
  queued: "queued",
  in_progress: "in_progress",
  completed: "completed",
  waiting: "queued",
  requested: "queued",
  pending: "queued",
};

const RELATIONS: readonly CommitRelation[] = [
  "ahead",
  "identical",
  "behind",
  "diverged",
];

/** A merge GitHub did not answer as documented. Names the step, never a token or a body. */
export class GitHubMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubMergeError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value !== "" && value.length <= max;
/** A path relative to the repository root as GitHub lists it. */
const isPath = (value: unknown): value is string =>
  isText(value, 4096) && !value.startsWith("/") && !value.includes("\u0000");

function isBranchName(branch: unknown): branch is string {
  return (
    typeof branch === "string" &&
    BRANCH.test(branch) &&
    !branch.startsWith("-") &&
    !branch.includes("..") &&
    branch
      .split("/")
      .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

function parseJson(body: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new GitHubReadError(`the ${what} answer is not JSON`);
  }
}

/**
 * A pull request as GitHub answers it. A full pull request says `merged`; one in a listing says
 * only `merged_at`. Before a merge, GitHub's `merge_commit_sha` is its test merge commit, so the
 * merge commit is read only once merged. A fork whose repository was deleted has no head
 * repository: its head repository is empty, which is never the base repository.
 */
function readPull(
  raw: unknown,
  what: string,
  listed: boolean,
): { pr: PullRequest; mergeable: unknown } {
  const malformed = () => new GitHubReadError(`the ${what} answer is malformed`);
  if (!isObject(raw)) throw malformed();
  const { number, state, head, base, user } = raw;
  if (!isId(number) || (state !== "open" && state !== "closed")) throw malformed();
  if (!isObject(head) || !isObject(base) || !isObject(user)) throw malformed();
  const repo = isObject(base.repo) ? base.repo.full_name : undefined;
  if (typeof repo !== "string" || !REPOSITORY.test(repo)) throw malformed();
  if (typeof head.sha !== "string" || !FULL_SHA.test(head.sha)) throw malformed();
  if (!isText(head.ref, 1000) || !isText(user.login, 100)) throw malformed();
  let headRepo = "";
  if (head.repo !== null) {
    const name = isObject(head.repo) ? head.repo.full_name : undefined;
    if (typeof name !== "string" || !REPOSITORY.test(name)) throw malformed();
    headRepo = name;
  }
  let merged: boolean;
  if (listed) {
    if (raw.merged_at !== null && !isText(raw.merged_at, 100)) throw malformed();
    merged = raw.merged_at !== null;
  } else {
    if (typeof raw.merged !== "boolean") throw malformed();
    merged = raw.merged;
  }
  if (merged && state !== "closed") throw malformed();
  let mergeCommitSha: string | null = null;
  if (merged) {
    const sha = raw.merge_commit_sha;
    if (typeof sha !== "string" || !FULL_SHA.test(sha)) throw malformed();
    mergeCommitSha = sha;
  }
  return {
    pr: {
      repo,
      number,
      state,
      merged,
      mergeCommitSha,
      headSha: head.sha,
      headBranch: head.ref,
      headRepo,
      author: user.login,
    },
    mergeable: raw.mergeable,
  };
}

/** A file's paths: its own, and a renamed file's old one too. */
function readFilePaths(raw: unknown): string[] {
  const malformed = () => new GitHubReadError("the changed files answer is malformed");
  if (!isObject(raw) || !isPath(raw.filename)) throw malformed();
  if (raw.previous_filename === undefined) return [raw.filename];
  if (!isPath(raw.previous_filename)) throw malformed();
  return [raw.filename, raw.previous_filename];
}

function readCheckRun(raw: unknown): CheckRun {
  const malformed = () => new GitHubReadError("the check runs answer is malformed");
  if (!isObject(raw) || !isId(raw.id) || !isText(raw.name, 1000)) throw malformed();
  const status = raw.status;
  if (typeof status !== "string" || !Object.hasOwn(CHECK_STATUS, status))
    throw malformed();
  const conclusion = raw.conclusion;
  if (conclusion !== null && (typeof conclusion !== "string" || !WORD.test(conclusion)))
    throw malformed();
  let appSlug: string | null = null;
  if (raw.app !== null) {
    if (!isObject(raw.app) || !isText(raw.app.slug, 100)) throw malformed();
    appSlug = raw.app.slug;
  }
  return {
    id: raw.id,
    name: raw.name,
    appSlug,
    status: CHECK_STATUS[status] as CheckRun["status"],
    conclusion,
  };
}

export interface RunnerGitHubOptions {
  /** The runner App's read tokens: one repository, one permission at read (O-125). */
  tokens: RunnerAppTokens;
  /** The runner App's merge token: one repository, `contents: write` (D-365). */
  mergeTokens: RunnerMergeTokens;
  http: GitHubHttp;
  write: GitHubWriteHttp;
}

export function createRunnerGitHub({
  tokens,
  mergeTokens,
  http,
  write,
}: RunnerGitHubOptions): GitHub {
  /** `didi-build/<name>` exactly, before any token is minted. */
  function repository(repo: string, fail: (message: string) => Error): string {
    const name = organizationRepositoryName(repo);
    if (name === null) throw fail(`not a repository of ${GITHUB_ORGANIZATION}`);
    return `${GITHUB_ORGANIZATION}/${name}`;
  }
  const readFail = (message: string) => new GitHubReadError(message);

  function pullNumber(number: number, fail: (message: string) => Error): number {
    if (!isId(number)) throw fail("not a pull request number");
    return number;
  }
  function commit(sha: string, fail: (message: string) => Error): string {
    if (!FULL_SHA.test(sha)) throw fail("a commit must be a full 40-character sha");
    return sha;
  }

  /** Every page of one listing with one token minted for it, until a short page. */
  async function listAll<T>(
    repo: string,
    permission: RunnerReadPermission,
    path: (page: number) => string,
    options: { what: string; key: string | null; maxPages: number },
    read: (raw: unknown) => T[],
  ): Promise<T[]> {
    const token = await tokens.mint({ repository: repo, permission });
    const all: T[] = [];
    for (let page = 1; page <= options.maxPages; page++) {
      const answer = await http.get({
        path: path(page),
        token,
        accept: "json",
        maxBytes: MAX_PAGE_BYTES,
      });
      if (answer.status !== 200) {
        throw new GitHubReadError(
          `listing the ${options.what} failed with ${answer.status}`,
        );
      }
      const parsed = parseJson(answer.body, options.what);
      const items =
        options.key === null
          ? parsed
          : isObject(parsed)
            ? parsed[options.key]
            : undefined;
      if (!Array.isArray(items) || items.length > PAGE_SIZE) {
        throw new GitHubReadError(`the ${options.what} answer is malformed`);
      }
      for (const item of items) all.push(...read(item));
      if (items.length < PAGE_SIZE) return all;
    }
    throw new GitHubReadError(
      `there are ${options.maxPages * PAGE_SIZE} or more ${options.what}, more than the runner reads, so none are used`,
    );
  }

  /** The pull request for `getPullRequest` and `getMergeability`, or null on 404. */
  async function readPullRequest(
    repo: string,
    number: number,
  ): Promise<{ pr: PullRequest; mergeable: unknown } | null> {
    const name = repository(repo, readFail);
    pullNumber(number, readFail);
    const token = await tokens.mint({ repository: name, permission: "pull_requests" });
    const answer = await http.get({
      path: `/repos/${name}/pulls/${number}`,
      token,
      accept: "json",
      maxBytes: MAX_OBJECT_BYTES,
    });
    if (answer.status === 404) return null;
    if (answer.status !== 200) {
      throw new GitHubReadError(
        `reading the pull request failed with ${answer.status}`,
      );
    }
    const read = readPull(
      parseJson(answer.body, "pull request"),
      "pull request",
      false,
    );
    if (read.pr.repo !== name || read.pr.number !== number) {
      throw new GitHubReadError("the pull request answer is for another pull request");
    }
    return read;
  }

  return {
    ...createGitHubWorkflowReads({ tokens, http }),

    async getPullRequest(repo, number) {
      return (await readPullRequest(repo, number))?.pr ?? null;
    },

    async listChangedPaths(repo, number) {
      const name = repository(repo, readFail);
      pullNumber(number, readFail);
      const paths = await listAll(
        name,
        "pull_requests",
        (page) =>
          `/repos/${name}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`,
        { what: "changed files", key: null, maxPages: MAX_FILE_PAGES },
        readFilePaths,
      );
      return [...new Set(paths)];
    },

    async listCheckRuns(repo, sha) {
      const name = repository(repo, readFail);
      commit(sha, readFail);
      return listAll(
        name,
        "checks",
        (page) =>
          `/repos/${name}/commits/${sha}/check-runs?filter=latest&per_page=${PAGE_SIZE}&page=${page}`,
        { what: "check runs", key: "check_runs", maxPages: MAX_CHECK_RUN_PAGES },
        (raw) => [readCheckRun(raw)],
      );
    },

    async listOpenPullRequests(repo) {
      const name = repository(repo, readFail);
      const pulls = await listAll(
        name,
        "pull_requests",
        (page) => `/repos/${name}/pulls?state=open&per_page=${PAGE_SIZE}&page=${page}`,
        { what: "open pull requests", key: null, maxPages: MAX_OPEN_PULL_PAGES },
        (raw) => [readPull(raw, "open pull requests", true).pr],
      );
      if (pulls.some((pr) => pr.repo !== name || pr.state !== "open")) {
        throw new GitHubReadError(
          "the open pull requests answer holds a pull request that is not open in this repository",
        );
      }
      return pulls;
    },

    async getMergeability(repo, number) {
      const read = await readPullRequest(repo, number);
      if (read === null) return null;
      const { mergeable } = read;
      if (mergeable !== null && typeof mergeable !== "boolean") {
        throw new GitHubReadError("the pull request answer is malformed");
      }
      return { headSha: read.pr.headSha, mergeable };
    },

    async squashMerge(repo, number, expectedHeadSha) {
      const fail = (message: string) => new GitHubMergeError(message);
      const name = repository(repo, fail);
      pullNumber(number, fail);
      commit(expectedHeadSha, fail);
      const token = await mergeTokens.mint(name);
      const answer = await write.send({
        method: "PUT",
        path: `/repos/${name}/pulls/${number}/merge`,
        token,
        body: { merge_method: "squash", sha: expectedHeadSha },
        maxBytes: MAX_MERGE_ANSWER_BYTES,
      });
      if (answer.status === 409) return { merged: false, reason: "head_changed" };
      if (answer.status === 405) return { merged: false, reason: "not_mergeable" };
      if (answer.status !== 200) {
        throw fail(`merging the pull request failed with ${answer.status}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(answer.body).toString("utf8"));
      } catch {
        throw fail("the merge answer is not JSON");
      }
      if (
        !isObject(parsed) ||
        parsed.merged !== true ||
        typeof parsed.sha !== "string" ||
        !FULL_SHA.test(parsed.sha)
      ) {
        throw fail("the merge answer is malformed");
      }
      return { merged: true, mergeCommitSha: parsed.sha };
    },

    async compareCommits(repo, base, head) {
      const name = repository(repo, readFail);
      commit(base, readFail);
      commit(head, readFail);
      const token = await tokens.mint({ repository: name, permission: "contents" });
      const answer = await http.get({
        path: `/repos/${name}/compare/${base}...${head}?per_page=1`,
        token,
        accept: "json",
        maxBytes: MAX_PAGE_BYTES,
      });
      if (answer.status !== 200) {
        throw new GitHubReadError(`comparing the commits failed with ${answer.status}`);
      }
      const parsed = parseJson(answer.body, "compare");
      const status = isObject(parsed) ? parsed.status : undefined;
      const relation = RELATIONS.find((r) => r === status);
      if (relation === undefined) {
        throw new GitHubReadError(
          "the compare answer has no relation the runner reads",
        );
      }
      return relation;
    },

    async getBranchHead(repo, branch) {
      const name = repository(repo, readFail);
      if (!isBranchName(branch)) throw readFail("not a branch name the runner reads");
      const token = await tokens.mint({ repository: name, permission: "contents" });
      const answer = await http.get({
        path: `/repos/${name}/branches/${encodeURIComponent(branch)}`,
        token,
        accept: "json",
        maxBytes: MAX_OBJECT_BYTES,
      });
      if (answer.status === 404) return null;
      if (answer.status !== 200) {
        throw new GitHubReadError(`reading the branch failed with ${answer.status}`);
      }
      const parsed = parseJson(answer.body, "branch");
      const sha =
        isObject(parsed) && isObject(parsed.commit) ? parsed.commit.sha : undefined;
      if (!isObject(parsed) || typeof sha !== "string" || !FULL_SHA.test(sha)) {
        throw new GitHubReadError("the branch answer is malformed");
      }
      if (parsed.name !== branch) {
        throw new GitHubReadError("the branch answer is for another branch");
      }
      return sha;
    },
  };
}
