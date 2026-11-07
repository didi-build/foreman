// The HTTP port for the runner's two POSTs to GitHub's REST API (D-346, O-109): minting the
// repository creation token with the runner App's own key, and creating a project repository from
// the template with that token. Tests pass a fake, so no test reaches the network. The token or
// key-signed value is sent only in the `Authorization` header and never kept or logged.
import { GitHubReadError, readBoundedBody } from "./runner-app-tokens.ts";

/** One POST to GitHub's REST API with a JSON body. */
export interface GitHubPostRequest {
  /** A path on `api.github.com`, starting with `/`. Never a full URL. */
  path: string;
  /** Sent as a bearer token: an installation token, or the App's signed token for a mint. */
  token: string;
  body: Record<string, unknown>;
  /** The most bytes the answer may have; a longer answer is refused. */
  maxBytes: number;
}

export interface GitHubPostResponse {
  status: number;
  body: Uint8Array;
}

export interface GitHubPostHttp {
  post(request: GitHubPostRequest): Promise<GitHubPostResponse>;
}

/** The time one POST may take before it is abandoned. */
const POST_TIMEOUT_MS = 60_000;

/**
 * The real port: GitHub's REST API with the token as a bearer token. A redirect is an error, so a
 * body and its token are never sent anywhere else. Not used in tests.
 */
export function createGitHubPostHttp(): GitHubPostHttp {
  return {
    async post({ path, token, body, maxBytes }) {
      if (!path.startsWith("/"))
        throw new GitHubReadError("a GitHub path must start with /");
      const response = await fetch(`https://api.github.com${path}`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "foreman-runner",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      return {
        status: response.status,
        body: await readBoundedBody(response, maxBytes),
      };
    },
  };
}
