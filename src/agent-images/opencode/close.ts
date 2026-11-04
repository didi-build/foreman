// The wrapper's close-only mode (D-318, O-98): a cancelled work item's open pull request, closed
// in plain code. When the run's task names the mode `close_pull_request`, the image starts no
// model: OpenCode is never run, no config or instructions are written and the checkout is not
// read. The wrapper reads the task's input strictly (src/core/pr-close-input.ts: the run's own
// repository, one pull request number and the fixed comment), then, with the run's own GitHub
// token through the same client it opens pull requests with (./github.ts):
// 1. reads that pull request;
// 2. refuses, writing nothing, when its head is not the item's branch in the run's repository
//    (the task's branch, `foreman/<node id>`);
// 3. reports a merged one as already merged and a closed one as already closed, writing nothing;
// 4. otherwise posts the fixed comment on it and closes it, and reports it closed.
// A pull request GitHub does not know is reported as not found. It touches no other pull request,
// no branch and no file. Any other answer from GitHub, or no answer, is an error with a text that
// names the step and GitHub's status, never a body or a token. The result's `structured` is
// exactly `{closeOutcome, pullRequest}`, which the runner records on the item.
import {
  readCloseInput,
  type CloseOutcome,
  type CloseResult,
} from "../../core/pr-close-input.ts";
import type { AgentResult } from "../shared/result.ts";
import type { GitHubApi } from "./github.ts";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The fixed start of each failure text, so the runner's record says which step failed. */
export const CLOSE_FAILURES = {
  input: "the close task's input is not usable",
  read: "the pull request was not read",
  comment: "the close comment was not posted",
  close: "the pull request was not closed",
} as const;

type Step = { ok: true; result: CloseResult } | { ok: false; text: string };

const said = (status: number | null): string =>
  status === null
    ? "GitHub could not be reached through the egress proxy"
    : `GitHub answered ${status}`;

/** Closes the one pull request the input names, or says why not. */
export async function closePullRequest(options: {
  github: GitHubApi;
  /** `owner/name`: the run's repository, which its token works for. */
  repository: string;
  /** The item's branch, from the task file. */
  branch: string;
  input: string;
}): Promise<Step> {
  const { github, repository, branch } = options;
  const input = readCloseInput(options.input, repository);
  if ("problem" in input) {
    return { ok: false, text: `${CLOSE_FAILURES.input}: ${input.problem}` };
  }
  const number = input.pullRequest;
  const done = (closeOutcome: CloseOutcome): Step => ({
    ok: true,
    result: { closeOutcome, pullRequest: number },
  });
  const pull = `/repos/${repository}/pulls/${number}`;

  const read = await github("GET", pull);
  if (read.status === 404) return done("not_found");
  if (read.status !== 200) {
    return { ok: false, text: `${CLOSE_FAILURES.read}: ${said(read.status)}` };
  }
  const body = read.body;
  const head = isObject(body) && isObject(body.head) ? body.head : null;
  const headRepo = head && isObject(head.repo) ? head.repo.full_name : null;
  if (
    !isObject(body) ||
    body.number !== number ||
    head === null ||
    typeof head.ref !== "string" ||
    (body.state !== "open" && body.state !== "closed") ||
    typeof body.merged !== "boolean"
  ) {
    return {
      ok: false,
      text: `${CLOSE_FAILURES.read}: GitHub's answer is not in the expected shape`,
    };
  }
  // Not the item's own pull request: nothing is written.
  if (head.ref !== branch || headRepo !== repository) return done("refused");
  if (body.merged) return done("already_merged");
  if (body.state === "closed") return done("already_closed");

  const comment = await github(
    "POST",
    `/repos/${repository}/issues/${number}/comments`,
    {
      body: input.comment,
    },
  );
  if (comment.status !== 201) {
    return { ok: false, text: `${CLOSE_FAILURES.comment}: ${said(comment.status)}` };
  }
  const closed = await github("PATCH", pull, { state: "closed" });
  if (
    closed.status !== 200 ||
    !isObject(closed.body) ||
    closed.body.state !== "closed"
  ) {
    return {
      ok: false,
      text: `${CLOSE_FAILURES.close}: ${
        closed.status === 200
          ? "GitHub's answer does not say it is closed"
          : said(closed.status)
      }`,
    };
  }
  return done("closed");
}

/** The close as the run's result line: no model ran, so no turns, tokens or cost. */
export function closeResult(step: Step): AgentResult {
  return {
    status: step.ok ? "success" : "error",
    finalText: "",
    ...(step.ok ? { structured: { ...step.result } } : {}),
    turns: 0,
    costUsd: 0,
    tokens: null,
    errorText: step.ok ? "" : step.text,
    providerError: null,
  };
}
