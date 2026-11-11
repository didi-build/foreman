// The default branch's head commit, read in the runner's own flow when a repo map or a scan is
// asked for with no commit (D-251, D-267, O-87). It reads two small JSON or sha answers with the
// runner App's `contents: read` token for one repository, and no code.
//
// It is kept apart from ./github.ts, whose archive read and TypeScript parse run only inside the
// repo map Job (src/agent-images/repo-map/), so the runner's flows never load the TypeScript
// compiler (O-121). Until the runner App is registered (D-178) the runner's token port refuses
// with `NotBuiltError` (flows/lib/compose.ts), so nothing is read. Tests pass fakes.
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
} from "../github/runner-app-tokens.ts";

export const FULL_SHA = /^[0-9a-f]{40}$/;

/** The largest JSON or sha answer the runner reads. */
const MAX_SMALL_BYTES = 1024 * 1024;

const text = (body: Uint8Array): string => Buffer.from(body).toString("utf8");

/** The default branch's head commit. */
export async function readHeadCommit(
  http: GitHubHttp,
  repo: string,
  token: string,
): Promise<string> {
  if (!REPOSITORY.test(repo)) throw new GitHubReadError("not a repository name");
  const about = await http.get({
    path: `/repos/${repo}`,
    token,
    accept: "json",
    maxBytes: MAX_SMALL_BYTES,
  });
  if (about.status !== 200) {
    throw new GitHubReadError(`reading the repository failed with ${about.status}`);
  }
  let branch: unknown;
  try {
    branch = (JSON.parse(text(about.body)) as { default_branch?: unknown })
      .default_branch;
  } catch {
    throw new GitHubReadError("the repository's answer is not JSON");
  }
  if (typeof branch !== "string" || branch === "") {
    throw new GitHubReadError("the repository has no default branch");
  }
  const head = await http.get({
    path: `/repos/${repo}/commits/${encodeURIComponent(branch)}`,
    token,
    accept: "sha",
    maxBytes: MAX_SMALL_BYTES,
  });
  const sha = text(head.body).trim();
  if (head.status !== 200 || !FULL_SHA.test(sha)) {
    throw new GitHubReadError(
      `reading the default branch's head failed with ${head.status}`,
    );
  }
  return sha;
}
