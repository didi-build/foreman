// The New project form's start of the Platform and Infra runs (src/core/new-project.ts
// `ProjectWorkflows`, ADR 0118 appendix C step 4, D-443, D-444, O-161), on GitHub's REST API.
//
// The step mints one workflow start token (./workflow-start-tokens.ts: `actions: write` on
// `didi-build/foreman` only) and makes exactly two calls with it, in this order, the only two in
// `WORKFLOW_START_CALLS`: GitHub's "Create a workflow dispatch event",
// `POST /repos/didi-build/foreman/actions/workflows/<file>/dispatches`, for `platform.yml` and then
// `infra-apply.yml`, each with exactly
//
//   {"ref": "main", "inputs": {"projects_commit": "<commit>"}, "return_run_details": true}
//
// `projects_commit` is the settings repository's commit that holds the project's file; each
// workflow checks that its run's settings commit is that one or contains it (O-157).
// `return_run_details` asks GitHub to answer 200 with the run's id and its page, `html_url`, which
// the form shows as the run's link; GitHub's older answer, 204 with no body, is a start too, and
// the link is then the workflow's runs. The page is kept only when it is exactly
// `https://github.com/didi-build/foreman/actions/runs/<id>`. Any other answer, or none, refuses
// that start with its status; the other start is still made, since each is harmless alone, and a
// re-run starts both again. A refused token starts neither. Nothing is tried again.
//
// The runner mints the token with its App's key (flows/lib/compose.ts, O-125). Tests pass fakes.
// Nothing here logs, and the token is never kept.
import type { ProjectWorkflows, WorkflowStart } from "../../core/new-project.ts";
import type { GitHubPostHttp } from "./post-http.ts";
import type { WorkflowStartTokens } from "./workflow-start-tokens.ts";

/** Foreman's repository, where both workflows live. */
export const FOREMAN_REPOSITORY = "didi-build/foreman";

/** The two workflows, by their file names (GitHub's `workflow_id`), in the order they start. */
export const PROJECT_WORKFLOW_FILES = {
  platform: "platform.yml",
  infra: "infra-apply.yml",
} as const;

/** The branch both run on. */
export const PROJECT_WORKFLOW_REF = "main";

/** The only calls the start token makes (D-443). */
export const WORKFLOW_START_CALLS: readonly string[] = Object.values(
  PROJECT_WORKFLOW_FILES,
).map((file) => `/repos/${FOREMAN_REPOSITORY}/actions/workflows/${file}/dispatches`);

const COMMIT = /^[0-9a-f]{40}$/;
const RUN_PAGE =
  /^https:\/\/github\.com\/didi-build\/foreman\/actions\/runs\/[1-9][0-9]{0,19}$/;
const MAX_ANSWER_BYTES = 64 * 1024;

export interface GitHubProjectWorkflowsOptions {
  tokens: WorkflowStartTokens;
  post: GitHubPostHttp;
}

/** The run's page from a 200 answer, when GitHub gives exactly one of Foreman's run pages. */
function runPageOf(body: Uint8Array): string | null {
  try {
    const answer: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
    const page =
      typeof answer === "object" && answer !== null
        ? (answer as Record<string, unknown>).html_url
        : undefined;
    return typeof page === "string" && RUN_PAGE.test(page) ? page : null;
  } catch {
    return null;
  }
}

export function createGitHubProjectWorkflows({
  tokens,
  post,
}: GitHubProjectWorkflowsOptions): ProjectWorkflows {
  return {
    async start(projectsCommit) {
      const refused = (step: "token" | "call"): WorkflowStart => ({
        kind: "refused",
        step,
      });
      if (!COMMIT.test(projectsCommit)) {
        return { platform: refused("call"), infra: refused("call") };
      }
      let token: string;
      try {
        // Minted once for this step's two calls, and never again with a wider request (D-443).
        token = await tokens.mint();
      } catch {
        return { platform: refused("token"), infra: refused("token") };
      }
      const startOne = async (file: string): Promise<WorkflowStart> => {
        const path = `/repos/${FOREMAN_REPOSITORY}/actions/workflows/${file}/dispatches`;
        if (!WORKFLOW_START_CALLS.includes(path)) return refused("call");
        let answer;
        try {
          answer = await post.post({
            path,
            token,
            body: {
              ref: PROJECT_WORKFLOW_REF,
              inputs: { projects_commit: projectsCommit },
              return_run_details: true,
            },
            maxBytes: MAX_ANSWER_BYTES,
          });
        } catch {
          return refused("call");
        }
        const runs = `https://github.com/${FOREMAN_REPOSITORY}/actions/workflows/${file}`;
        if (answer.status === 204) return { kind: "started", link: runs };
        if (answer.status === 200)
          return { kind: "started", link: runPageOf(answer.body) ?? runs };
        return { kind: "refused", step: "call", status: answer.status };
      };
      const platform = await startOne(PROJECT_WORKFLOW_FILES.platform);
      const infra = await startOne(PROJECT_WORKFLOW_FILES.infra);
      return { platform, infra };
    },
  };
}
