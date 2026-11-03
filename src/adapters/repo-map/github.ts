// The runner's repo map port (src/core/repo-map.ts `RepoMaps`, D-251, D-267, N-62). The runner
// itself reads a project's code at a commit from GitHub with a read-only installation token of the
// runner App that carries only `contents: read` for that one repository, unpacks the archive in
// memory (./tarball.ts) and builds the map with the TypeScript compiler (./typescript.ts), which
// parses and never runs the code. With no commit it reads the default branch's head first, so the
// Triage run records the commit its map came from. No new job kind, image, cluster workload or
// cluster permission: the read runs in the runner's own flow.
//
// Until the runner App is registered (D-178) the token port refuses with `NotBuiltError`
// (flows/lib/compose.ts), so no map is read and no Triage run starts. Tests pass fakes.
import type { RepoMap, RepoMaps } from "../../core/repo-map.ts";
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
  type RunnerAppTokens,
} from "../github/runner-app-tokens.ts";
import { readTarball } from "./tarball.ts";
import { buildRepoMap } from "./typescript.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The largest archive the runner downloads, compressed. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
/** The largest JSON or sha answer the runner reads. */
const MAX_SMALL_BYTES = 1024 * 1024;

const text = (body: Uint8Array): string => Buffer.from(body).toString("utf8");

export interface GitHubRepoMapsOptions {
  tokens: RunnerAppTokens;
  http: GitHubHttp;
}

export function createGitHubRepoMaps({
  tokens,
  http,
}: GitHubRepoMapsOptions): RepoMaps {
  /** The default branch's head commit. */
  async function headCommit(repo: string, token: string): Promise<string> {
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

  return {
    async read(repo: string, commitSha?: string): Promise<RepoMap> {
      if (!REPOSITORY.test(repo)) throw new GitHubReadError("not a repository name");
      if (commitSha !== undefined && !FULL_SHA.test(commitSha)) {
        throw new GitHubReadError("a commit must be a full 40-character sha");
      }
      // Minted for this read only, with contents read on this repository only (D-267).
      const token = await tokens.mint({ repository: repo, permission: "contents" });
      const sha = commitSha ?? (await headCommit(repo, token));
      const archive = await http.get({
        path: `/repos/${repo}/tarball/${sha}`,
        token,
        accept: "raw",
        maxBytes: MAX_ARCHIVE_BYTES,
      });
      if (archive.status !== 200) {
        throw new GitHubReadError(`downloading the code failed with ${archive.status}`);
      }
      return buildRepoMap(sha, readTarball(archive.body));
    },
  };
}
