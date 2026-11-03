// What the wrapper does after OpenCode ends with success (N-44, D-235): plain code, not the
// model. It reads the run's report from the final message, opens or reuses the PR for the
// run's branch with the run's GitHub token, and posts the docs note to the state API with the
// run's state API token. Any step that fails turns the run into an error with a text that names
// the step, so the runner records a failed run, never a guessed PR or note. The result line
// then carries the PR, which is the done report's "naming the PR" (contracts/machine-2/code.yaml).
// The runner itself links the PR from GitHub's events and reads the note from the state store.
// When the report is the stopped form (the item needs a product decision or a new feature, D-237),
// the wrapper reads no branch, opens no PR and posts no note: the result is `needs_decision` with
// the reason in `structured`, and the runner asks for the escalation (O-63). Commits the model
// pushed, if any, stay on the branch as they are. A success result also carries the bugs the run
// noticed outside its item, with credential values removed (D-244, O-65): the runner submits each
// as a new idea; the wrapper itself sends them nowhere.
import { withinFindingBounds } from "../../core/out-of-scope-findings.ts";
import type { AgentResult } from "../shared/result.ts";
import { redact } from "../shared/result.ts";
import type { GitHubApi } from "./github.ts";
import { openOrReusePullRequest } from "./pull-request.ts";
import { MAX_STOP_REASON, parseRunReport, postDocsNote } from "./report.ts";

export interface FinishContext {
  github: GitHubApi;
  repository: string;
  branch: string;
  nodeId: string;
  stateApiUrl: string;
  stateApiToken: string;
  /** Every credential value, removed from the PR's description before it is sent. */
  secrets: readonly string[];
  fetchImpl?: typeof fetch;
}

/** The fixed start of each failure text, so the runner's record says which step failed. */
export const FINISH_FAILURES = {
  report: "the final message has no usable report",
  pullRequest: "the run's pull request was not opened",
  docsNote: "the docs note was not recorded",
} as const;

const failed = (result: AgentResult, errorText: string): AgentResult => ({
  ...result,
  status: "error",
  errorText,
});

export async function finishRun(
  result: AgentResult,
  context: FinishContext,
): Promise<AgentResult> {
  if (result.status !== "success") return result;
  const parsed = parseRunReport(result.finalText);
  if ("problem" in parsed) {
    return failed(result, `${FINISH_FAILURES.report}: ${parsed.problem}`);
  }
  if ("stopped" in parsed) {
    return {
      ...result,
      status: "needs_decision",
      structured: {
        stopped: parsed.stopped.stopped,
        // Redacting can lengthen the text; the runner refuses a reason over the bound.
        reason: redact(parsed.stopped.reason, context.secrets).slice(
          0,
          MAX_STOP_REASON,
        ),
      },
    };
  }
  const { report } = parsed;

  const opened = await openOrReusePullRequest({
    github: context.github,
    repository: context.repository,
    branch: context.branch,
    title: redact(report.pullRequestTitle, context.secrets),
    body: redact(
      report.summary === "" ? "The run gave no summary." : report.summary,
      context.secrets,
    ),
  });
  if (!opened.ok) {
    return failed(result, `${FINISH_FAILURES.pullRequest}: ${opened.text}`);
  }
  const { pullRequest } = opened;

  const posted = await postDocsNote({
    stateApiUrl: context.stateApiUrl,
    token: context.stateApiToken,
    nodeId: context.nodeId,
    pullRequestUrl: pullRequest.url,
    commitSha: pullRequest.headSha,
    docsNote: report.docsNote,
    ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
  });
  if (!posted.ok) {
    return failed(
      result,
      `${FINISH_FAILURES.docsNote}: ${
        posted.status === null
          ? "the state API could not be reached"
          : `the state API answered ${posted.status}`
      }`,
    );
  }
  return {
    ...result,
    structured: {
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
        headSha: pullRequest.headSha,
        reused: pullRequest.reused,
      },
      docsNote: { impact: report.docsNote.impact },
      ...(report.outOfScopeFindings.length === 0
        ? {}
        : {
            outOfScopeFindings: redact(report.outOfScopeFindings, context.secrets).map(
              withinFindingBounds,
            ),
          }),
    },
  };
}
