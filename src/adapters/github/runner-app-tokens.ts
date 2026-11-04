// The runner App's own read-only installation tokens (D-267, D-127, D-178). Didi registers the
// runner App at first hosting with two read-only permissions beyond D-127: `contents: read`, so the
// runner can fetch a project's code at a commit to build the repo map (D-251) and, with the same
// permission, check a folder's tree id (D-281) and whether the repository is private (O-89), and `actions:
// read`, so it can download CI's screenshot bundles as workflow artifacts (D-242). Each token the
// runner mints for these reads names one repository and exactly one of the two permissions, read
// only (GitHub lets an installation token ask for fewer permissions than the App has), so a token
// minted for the repo map cannot read artifacts, and neither can write, merge or deploy. GitHub
// caps a token at one hour; the runner uses it for one read and never keeps or logs it. The repo
// map's token is the one token that leaves the runner: it goes into the repo map Job's own Secret,
// deleted when the Job ends (D-275 (2), O-87).
//
// The real implementation needs the runner App and its private key, which the runner holds, so
// until the App is registered through the new-credentials gate (D-178) the runner's port refuses
// with `NotBuiltError` (flows/lib/compose.ts), and tests pass a fake.
import { REPOSITORY } from "../../core/github.ts";

/** The two read permissions D-267 adds to the runner App, each minted on its own. */
export type RunnerReadPermission = "contents" | "actions";

export interface RunnerAppTokenRequest {
  /** `owner/name`: the token works for this repository only. */
  repository: string;
  /** The one permission the token carries, read only. */
  permission: RunnerReadPermission;
}

export interface RunnerAppTokens {
  /** A new read-only installation token for one repository and one permission. Never logged. */
  mint(request: RunnerAppTokenRequest): Promise<string>;
}

/** `owner/name` as GitHub spells a repository, from the core (src/core/github.ts). */
export { REPOSITORY };

/** One GET to GitHub's REST API, as the runner's reads need it. */
export interface GitHubGetRequest {
  /** A path on `api.github.com`, starting with `/`, with its query. Never a full URL. */
  path: string;
  token: string;
  /** The `Accept` header: JSON by default, the commit sha, or the raw bytes of an archive. */
  accept: "json" | "sha" | "raw";
  /** The most bytes the body may have; a longer body is refused. */
  maxBytes: number;
}

export interface GitHubGetResponse {
  status: number;
  body: Uint8Array;
}

/**
 * The HTTP port the repo map and the screenshot bundles read GitHub through. The real one
 * (`createGitHubHttp`) follows GitHub's redirect to the archive or artifact download; tests pass
 * a fake, so no test reaches the network.
 */
export interface GitHubHttp {
  get(request: GitHubGetRequest): Promise<GitHubGetResponse>;
}

/** A read GitHub refused or that broke a bound. The message names the step, never a token. */
export class GitHubReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubReadError";
  }
}

const ACCEPT: Record<GitHubGetRequest["accept"], string> = {
  json: "application/vnd.github+json",
  sha: "application/vnd.github.sha",
  raw: "application/octet-stream",
};

/** The time one read may take before it is abandoned. */
const READ_TIMEOUT_MS = 120_000;

/**
 * The real HTTP port, used by the runner and inside the repo map Job, where `fetch` goes through
 * the Job's egress proxy (NODE_USE_ENV_PROXY, src/agent-images/repo-map/image.ts). GitHub's REST
 * API with the token as a bearer token. A redirect (the archive
 * and artifact downloads answer with one to a signed address) is followed by `fetch`, which drops
 * the `Authorization` header when the redirect leaves the API's origin. Not used in tests.
 */
export function createGitHubHttp(): GitHubHttp {
  return {
    async get({ path, token, accept, maxBytes }) {
      if (!path.startsWith("/"))
        throw new GitHubReadError("a GitHub path must start with /");
      const response = await fetch(`https://api.github.com${path}`, {
        headers: {
          accept: ACCEPT[accept],
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "foreman-runner",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        await response.body?.cancel();
        throw new GitHubReadError(`GitHub's answer is larger than ${maxBytes} bytes`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      for (;;) {
        const next = await reader?.read();
        if (!next || next.done) break;
        size += next.value.length;
        if (size > maxBytes) {
          await reader?.cancel();
          throw new GitHubReadError(`GitHub's answer is larger than ${maxBytes} bytes`);
        }
        chunks.push(next.value);
      }
      const body = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.length;
      }
      return { status: response.status, body };
    },
  };
}
