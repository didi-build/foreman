// The repo map's two GitHub reads (D-251, D-267, D-275 (2), O-87), each with a read-only
// installation token of the runner App that carries only `contents: read` for one repository.
//
// - `readHeadCommit`, in the runner's own flow: the default branch's head commit, when a map is
//   asked for with no commit. It reads two small JSON or sha answers and no code.
// - `readRepoMapAt`, inside the repo map Job only (src/agent-images/repo-map/): the archive at one
//   commit, unpacked in memory (./tarball.ts) and parsed with the TypeScript compiler
//   (./typescript.ts), which never runs the code. The Job's scan mode reads the same archive with
//   `readArchiveAt` (./scan.ts, O-92). The runner process never downloads or parses
//   project code; it reads back only the map (./result.ts).
//
// Until the runner App is registered (D-178) the runner's token port refuses with `NotBuiltError`
// (flows/lib/compose.ts), so no map is read and no Triage run starts. Tests pass fakes.
import type { RepoMap } from "../../core/repo-map.ts";
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
} from "../github/runner-app-tokens.ts";
import { readTarball } from "./tarball.ts";
import { buildRepoMap } from "./typescript.ts";

export const FULL_SHA = /^[0-9a-f]{40}$/;

/** The largest archive the Job downloads, compressed. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
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

/**
 * The archive at `commitSha`, downloaded and unpacked in memory (./tarball.ts). `alsoKeep` names
 * files whose text is kept besides the code the map parses (the Scanner's, O-92).
 */
export async function readArchiveAt(
  http: GitHubHttp,
  repo: string,
  commitSha: string,
  token: string,
  alsoKeep?: (path: string) => boolean,
): Promise<Map<string, string>> {
  if (!REPOSITORY.test(repo)) throw new GitHubReadError("not a repository name");
  if (!FULL_SHA.test(commitSha)) {
    throw new GitHubReadError("a commit must be a full 40-character sha");
  }
  const archive = await http.get({
    path: `/repos/${repo}/tarball/${commitSha}`,
    token,
    accept: "raw",
    maxBytes: MAX_ARCHIVE_BYTES,
  });
  if (archive.status !== 200) {
    throw new GitHubReadError(`downloading the code failed with ${archive.status}`);
  }
  return readTarball(archive.body, alsoKeep);
}

/** The map of the code at `commitSha`: the archive downloaded, unpacked in memory and parsed. */
export async function readRepoMapAt(
  http: GitHubHttp,
  repo: string,
  commitSha: string,
  token: string,
): Promise<RepoMap> {
  return buildRepoMap(commitSha, await readArchiveAt(http, repo, commitSha, token));
}
