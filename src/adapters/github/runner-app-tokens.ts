// The runner App's own read-only installation tokens (D-267, D-127, D-178). Didi registers the
// runner App at first hosting with two read-only permissions beyond D-127: `contents: read`, so the
// runner can fetch a project's code at a commit to build the repo map (D-251) and, with the same
// permission, check a folder's tree id (D-281) and, for Didi's register-project form, read the
// platform settings file on `didi-build/foreman`'s main and an existing project repository (D-345,
// O-109), and `actions: read`, so it can download CI's screenshot bundles as workflow artifacts
// (D-242). The runner's own GitHub client (./runner-github.ts, D-381) reads pull requests with
// `pull_requests: read` and check runs with `checks: read`, both in D-365's runner App permissions.
// Each token the runner mints for these reads names one repository and exactly one of the four
// permissions, read only (GitHub lets an installation token ask for fewer permissions than the App
// has), so a token minted for the repo map cannot read artifacts or pull requests, and none of them
// can write, merge or deploy. The merge's `contents: write` has its own port (./merge-tokens.ts).
// GitHub caps a token at one hour; the runner uses it for one read and never keeps or logs it.
// The repo map's token is the one token that leaves the runner: it goes into the repo map
// Job's own Secret, deleted when the Job ends (D-275 (2), O-87).
//
// The real implementation signs with the runner App's private key, which only the runner holds
// (./runner-read-tokens.ts, read on first use by flows/lib/compose.ts, O-125); tests pass a fake.
// It is kept out of this file, which the repo map and QA fetch images copy.
import { REPOSITORY } from "../../core/github.ts";

/**
 * The runner App's read permissions, each minted on its own: `contents` and `actions` from D-267,
 * `pull_requests` and `checks` from D-365 for the runner's own GitHub client (D-381).
 */
export type RunnerReadPermission = "contents" | "actions" | "pull_requests" | "checks";

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
  /**
   * The `Accept` header: JSON, the commit sha, or a download (an archive or an artifact), which
   * GitHub answers with a redirect to the file itself.
   */
  accept: "json" | "sha" | "download";
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

/**
 * The `Accept` header for each kind of read. A download asks for GitHub's own JSON type: the
 * tarball and artifact routes answer it with a 302 to the file, which `fetch` follows, and refuse
 * `application/octet-stream` with 415 (checked against api.github.com on 2026-11-13, O-131: the
 * rehearsal's first repo map read failed so).
 */
export const GITHUB_ACCEPT: Readonly<Record<GitHubGetRequest["accept"], string>> = {
  json: "application/vnd.github+json",
  sha: "application/vnd.github.sha",
  download: "application/vnd.github+json",
};

/** The time one read may take before it is abandoned. */
const READ_TIMEOUT_MS = 120_000;

/**
 * One GET to GitHub's REST API with the token as a bearer token, its body not read yet. A
 * redirect (the archive and artifact downloads answer with one to a signed address) is followed
 * by `fetch`, which drops the `Authorization` header when the redirect leaves the API's origin.
 * `createGitHubHttp` reads the body whole; QA's fetch step reads its archive as it arrives, with
 * QA's own read token (src/agent-images/qa-fetch/, O-124).
 */
export async function githubApiGet(
  path: string,
  token: string,
  accept: GitHubGetRequest["accept"],
): Promise<Response> {
  if (!path.startsWith("/"))
    throw new GitHubReadError("a GitHub path must start with /");
  return fetch(`https://api.github.com${path}`, {
    headers: {
      accept: GITHUB_ACCEPT[accept],
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "foreman-runner",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
}

/**
 * The real HTTP port, used by the runner and inside the repo map Job, where `fetch` goes through
 * the Job's egress proxy (NODE_USE_ENV_PROXY, src/agent-images/repo-map/image.ts): one
 * `githubApiGet` and its body read with a bound. Not used in tests.
 */
export function createGitHubHttp(): GitHubHttp {
  return {
    async get({ path, token, accept, maxBytes }) {
      const response = await githubApiGet(path, token, accept);
      return {
        status: response.status,
        body: await readBoundedBody(response, maxBytes),
      };
    },
  };
}

/** Reads an answer's body, refusing one longer than `maxBytes` before or while it arrives. */
export async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
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
  return body;
}
