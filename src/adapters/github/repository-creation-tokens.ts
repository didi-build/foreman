// The runner App's repository creation token (D-346, O-109). Only Didi's register-project form
// mints it, for one create from the template. The installation token request names exactly the
// template repository and two permissions (GitHub's `repositories` and `permissions` parameters):
// `contents: read` on `launchpad` and `repository_creation: write`, the set GitHub's docs give for
// "Create a repository using a template" without "Administration". Every other runner token is
// minted without the creation permission (./runner-app-tokens.ts), so none of them carries it.
//
// Unproven until the first real run, so built to fail closed (runbook, "Registering a project"):
// GitHub's documented `permissions` keys for an installation token (read 2026-11-07) list no key
// for "Repository creation", so the key `repository_creation` is the permission page's name in
// GitHub's snake case, and whether a token narrowed to `launchpad` may create a new repository in
// the organization is not known. A refused mint throws; it is never tried again with a wider
// request, without `permissions` or without `repositories`. A token GitHub grants wider than asked
// (another permission, another level, or all repositories) is refused too, and not used.
//
// The real minting signs with the runner App's private key, which the runner holds; until the App
// is registered through the new-credentials gate (D-178) the runner's port refuses with
// `NotBuiltError` (flows/lib/compose.ts), and tests pass a fake. The token is never kept or logged.
import type { GitHubPostHttp } from "./post-http.ts";

/** The repositories the creation token may reach: the template only. */
export const CREATION_TOKEN_REPOSITORIES = ["launchpad"] as const;

/** The permissions the creation token asks for, exactly (D-346). */
export const CREATION_TOKEN_PERMISSIONS = {
  contents: "read",
  repository_creation: "write",
} as const;

/** What GitHub may grant: the two asked for, and the metadata read every token gets. */
const GRANTABLE: Record<string, string> = {
  ...CREATION_TOKEN_PERMISSIONS,
  metadata: "read",
};

export interface RepositoryCreationTokens {
  /** A new installation token for the template only, with exactly the two permissions. Never logged. */
  mint(): Promise<string>;
}

/** The runner App's own short-lived signed token (a JWT made with its private key). Never logged. */
export interface GitHubAppJwt {
  sign(): Promise<string>;
}

/** A mint GitHub refused, or a token it granted wider than asked. Names the step, never a token. */
export class RepositoryCreationTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryCreationTokenError";
  }
}

export interface RepositoryCreationTokenOptions {
  appJwt: GitHubAppJwt;
  /** The runner App's installation on the `didi-build` organization. */
  installationId: number;
  http: GitHubPostHttp;
}

/** The largest token answer the runner reads. */
const MAX_TOKEN_ANSWER_BYTES = 256 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether GitHub granted no more than was asked: the permissions and the one repository. */
function grantedAsAsked(answer: Record<string, unknown>): boolean {
  const permissions = answer.permissions;
  if (!isObject(permissions)) return false;
  for (const [name, level] of Object.entries(permissions)) {
    if (GRANTABLE[name] !== level) return false;
  }
  if (answer.repository_selection !== "selected") return false;
  if (answer.repositories === undefined) return true;
  const repositories = answer.repositories;
  return (
    Array.isArray(repositories) &&
    repositories.length === CREATION_TOKEN_REPOSITORIES.length &&
    repositories.every(
      (r, i) => isObject(r) && r.name === CREATION_TOKEN_REPOSITORIES[i],
    )
  );
}

export function createRepositoryCreationTokens({
  appJwt,
  installationId,
  http,
}: RepositoryCreationTokenOptions): RepositoryCreationTokens {
  return {
    async mint() {
      if (!Number.isSafeInteger(installationId) || installationId <= 0) {
        throw new RepositoryCreationTokenError(
          "the installation id is not a positive number",
        );
      }
      const answer = await http.post({
        path: `/app/installations/${installationId}/access_tokens`,
        token: await appJwt.sign(),
        body: {
          repositories: [...CREATION_TOKEN_REPOSITORIES],
          permissions: { ...CREATION_TOKEN_PERMISSIONS },
        },
        maxBytes: MAX_TOKEN_ANSWER_BYTES,
      });
      if (answer.status !== 201) {
        throw new RepositoryCreationTokenError(
          `GitHub refused the repository creation token with ${answer.status}`,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.from(answer.body).toString("utf8"));
      } catch {
        throw new RepositoryCreationTokenError("the token answer is not JSON");
      }
      if (!isObject(body) || typeof body.token !== "string" || body.token === "") {
        throw new RepositoryCreationTokenError("the token answer holds no token");
      }
      if (!grantedAsAsked(body)) {
        throw new RepositoryCreationTokenError(
          "GitHub granted the repository creation token more than was asked, so it is not used",
        );
      }
      return body.token;
    },
  };
}
