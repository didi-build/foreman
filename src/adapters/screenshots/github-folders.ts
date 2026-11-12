// The runner's repo folders port (src/core/visual-comparison.ts `RepoFolders`, D-281, D-267). The
// visual comparison renders the approved option from the build PR's own head, so before it compares
// anything the runner checks that the option's folder is the one Didi approved: its git tree id at
// the commit the option was captured at must equal its tree id at the head. The tree id covers every
// file under the folder, so equal ids mean nothing under it changed.
//
// With a read-only installation token of the runner App that carries only `contents: read` for
// that one repository (the same permission the repo map reads with), it lists the folder's parent
// at the commit (`GET /repos/{repo}/contents/{parent}?ref={sha}`) and takes the `sha` of the entry
// that is the folder, a directory. A missing parent (404) or no such directory is no folder (null),
// which the comparison refuses. Any other answer throws, so nothing is compared on a failed read.
//
// The runner mints the token with its App's key (flows/lib/compose.ts, O-125). Tests pass fakes.
import type { RepoFolders } from "../../core/visual-comparison.ts";
import {
  GitHubReadError,
  REPOSITORY,
  type GitHubHttp,
  type RunnerAppTokens,
} from "../github/runner-app-tokens.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
/** A folder path as the comparison asks for it: plain parts, no dot-dot, no leading slash. */
const FOLDER = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;
/** The largest folder listing the runner reads. */
const MAX_LISTING_BYTES = 1024 * 1024;

export interface GitHubRepoFoldersOptions {
  tokens: RunnerAppTokens;
  http: GitHubHttp;
}

export function createGitHubRepoFolders({
  tokens,
  http,
}: GitHubRepoFoldersOptions): RepoFolders {
  return {
    async folderId(
      repo: string,
      commitSha: string,
      path: string,
    ): Promise<string | null> {
      if (!REPOSITORY.test(repo)) throw new GitHubReadError("not a repository name");
      if (!FULL_SHA.test(commitSha)) {
        throw new GitHubReadError("a commit must be a full 40-character sha");
      }
      if (!FOLDER.test(path)) throw new GitHubReadError("not a folder path");
      // Minted for this read only, with contents read on this repository only (D-267).
      const token = await tokens.mint({ repository: repo, permission: "contents" });
      const parent = path.slice(0, path.lastIndexOf("/"));
      const listing = await http.get({
        path: `/repos/${repo}/contents/${parent.split("/").map(encodeURIComponent).join("/")}?ref=${commitSha}`,
        token,
        accept: "json",
        maxBytes: MAX_LISTING_BYTES,
      });
      if (listing.status === 404) return null;
      if (listing.status !== 200) {
        throw new GitHubReadError(`listing the folder failed with ${listing.status}`);
      }
      let entries: unknown;
      try {
        entries = JSON.parse(Buffer.from(listing.body).toString("utf8"));
      } catch {
        throw new GitHubReadError("the folder listing is not JSON");
      }
      if (!Array.isArray(entries)) return null;
      for (const raw of entries as unknown[]) {
        const e = raw as Record<string, unknown>;
        if (e.path === path && e.type === "dir") {
          if (typeof e.sha !== "string" || !FULL_SHA.test(e.sha)) {
            throw new GitHubReadError("the folder listing gives no tree id");
          }
          return e.sha;
        }
      }
      return null;
    },
  };
}
