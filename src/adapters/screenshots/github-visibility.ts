// The runner's repository visibility port (src/core/option-capture.ts `RepoVisibility`, O-89).
// Option capture links Didi's visual-approval request to the CI run whose artifact holds the
// screenshots, and on a public repository any signed-in GitHub user can download that artifact,
// so the runner first checks that the repository is private.
//
// With a read-only installation token of the runner App that carries only `contents: read` for
// that one repository (the permission the repo map and the folder check already use, D-267), it
// reads `GET /repos/{repo}` and answers true only when `private` is true, `visibility` (when
// GitHub gives it) is `private`, and `full_name` is the repository asked for. An `internal`
// repository, which every member of its enterprise can read, is not private here. Any other
// answer throws, and capture treats a throw as not private, so nothing is linked on a failed read.
//
// Until the runner App is registered (D-178) the token port refuses with `NotBuiltError`
// (flows/lib/compose.ts). Tests pass fakes.
import type { RepoVisibility } from "../../core/option-capture.ts";
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
  type RunnerAppTokens,
} from "../github/runner-app-tokens.ts";

/** The largest repository answer the runner reads. */
const MAX_REPOSITORY_BYTES = 1024 * 1024;

export interface GitHubRepoVisibilityOptions {
  tokens: RunnerAppTokens;
  http: GitHubHttp;
}

export function createGitHubRepoVisibility({
  tokens,
  http,
}: GitHubRepoVisibilityOptions): RepoVisibility {
  return {
    async isPrivate(repo: string): Promise<boolean> {
      if (!REPOSITORY.test(repo)) throw new GitHubReadError("not a repository name");
      // Minted for this read only, with contents read on this repository only (D-267).
      const token = await tokens.mint({ repository: repo, permission: "contents" });
      const answer = await http.get({
        path: `/repos/${repo}`,
        token,
        accept: "json",
        maxBytes: MAX_REPOSITORY_BYTES,
      });
      if (answer.status !== 200) {
        throw new GitHubReadError(
          `reading the repository failed with ${answer.status}`,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.from(answer.body).toString("utf8"));
      } catch {
        throw new GitHubReadError("the repository answer is not JSON");
      }
      const r = (body ?? {}) as Record<string, unknown>;
      if (
        typeof r.full_name !== "string" ||
        r.full_name.toLowerCase() !== repo.toLowerCase()
      ) {
        throw new GitHubReadError("the repository answer names another repository");
      }
      if (typeof r.private !== "boolean") {
        throw new GitHubReadError("the repository answer gives no visibility");
      }
      return (
        r.private === true && (r.visibility === undefined || r.visibility === "private")
      );
    },
  };
}
