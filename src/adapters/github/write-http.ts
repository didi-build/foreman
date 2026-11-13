// The HTTP port for the runner's `PUT` and `DELETE` writes to GitHub's REST API: adding a
// repository to an organization secret's selected repositories (`PUT`) and removing it
// (`DELETE`), both without a body (D-358, O-114), and the squash merge (`PUT` with a JSON body,
// ./runner-github.ts, D-381). Tests pass a fake, so no test reaches the network. The token is sent
// only in the `Authorization` header and never kept or logged.
import type { GitHubPostResponse } from "./post-http.ts";
import { GitHubReadError, readBoundedBody } from "./runner-app-tokens.ts";

export interface GitHubWriteRequest {
  method: "PUT" | "DELETE";
  /** A path on `api.github.com`, starting with `/`. Never a full URL. */
  path: string;
  /** Sent as a bearer token. */
  token: string;
  /** A JSON body, when the call takes one; without it nothing is sent but the headers. */
  body?: Record<string, unknown>;
  /** The most bytes the answer may have; a longer answer is refused. */
  maxBytes: number;
}

export interface GitHubWriteHttp {
  send(request: GitHubWriteRequest): Promise<GitHubPostResponse>;
}

/** The time one write may take before it is abandoned. */
const WRITE_TIMEOUT_MS = 60_000;

/**
 * The real port: GitHub's REST API with the token as a bearer token. A redirect is an error, so
 * the token is never sent anywhere else. Not used in tests.
 */
export function createGitHubWriteHttp(): GitHubWriteHttp {
  return {
    async send({ method, path, token, body, maxBytes }) {
      if (!path.startsWith("/"))
        throw new GitHubReadError("a GitHub path must start with /");
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "x-github-api-version": "2022-11-28",
          "user-agent": "foreman-runner",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      });
      return {
        status: response.status,
        body: await readBoundedBody(response, maxBytes),
      };
    },
  };
}
