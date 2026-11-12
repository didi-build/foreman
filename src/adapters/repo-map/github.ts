// The repo map's archive read inside the repo map Job only (src/agent-images/repo-map/, D-251,
// D-267, D-275 (2), O-87), with a read-only installation token of the runner App that carries
// only `contents: read` for one repository: the archive at one commit, unpacked in memory
// (./tarball.ts) and parsed with the TypeScript compiler (./typescript.ts), which never runs the
// code. The Job's scan mode reads the same archive with `readArchiveAt` (./scan.ts, O-92). The
// runner process never downloads or parses project code: its one read, the default branch's head
// commit, is ./head-commit.ts, kept apart so the runner's flows never load the compiler (O-121),
// and it reads back only the map (./result.ts).
//
// The runner mints the token with its App's key (src/adapters/github/runner-read-tokens.ts,
// flows/lib/compose.ts, O-125). Tests pass fakes.
import type { RepoMap } from "../../core/repo-map.ts";
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
} from "../github/runner-app-tokens.ts";
import { FULL_SHA } from "./head-commit.ts";
import { readTarball } from "./tarball.ts";
import { buildRepoMap } from "./typescript.ts";

/** The largest archive the Job downloads, compressed. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

/**
 * The archive at `commitSha`, downloaded and unpacked in memory (./tarball.ts). `alsoKeep` names
 * files whose text is kept besides the code the map parses (the Scanner's, O-92), and `tooLarge`
 * collects the wanted files whose text was too large to keep (D-301).
 */
export async function readArchiveAt(
  http: GitHubHttp,
  repo: string,
  commitSha: string,
  token: string,
  alsoKeep?: (path: string) => boolean,
  tooLarge?: Set<string>,
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
  return readTarball(archive.body, alsoKeep, tooLarge);
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
