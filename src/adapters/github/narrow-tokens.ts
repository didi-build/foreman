// One installation token of the runner App, narrowed at creation to the repositories and the
// permissions of its one step (D-346, D-358): GitHub's `POST /app/installations/<id>/access_tokens`
// with exactly a `repositories` list and a `permissions` object, signed with the runner App's own
// key. GitHub's reference ("Create an installation access token for an app", read 2026-11-07)
// says a token asks for fewer repositories or permissions than the App has, and that leaving
// either out gives all of the installation's.
//
// Fail closed: a refused mint, an answer with no token, or a token GitHub grants wider than asked
// (another permission or level, besides the `metadata: read` every token gets, a
// `repository_selection` other than `selected`, or another repository) throws, and the token is
// not used. Nothing tries again, with the same request or a wider one. The token and the signed
// value are never kept, logged or named in an error.
import type { GitHubPostHttp } from "./post-http.ts";

/** The runner App's own short-lived signed token (a JWT made with its private key). Never logged. */
export interface GitHubAppJwt {
  sign(): Promise<string>;
}

export interface NarrowTokenOptions {
  appJwt: GitHubAppJwt;
  /** The runner App's installation on the `didi-build` organization. */
  installationId: number;
  http: GitHubPostHttp;
}

/** Exactly what one step's token asks for. */
export interface NarrowTokenRequest {
  /** The repository names the token may reach, in the organization. */
  repositories: readonly string[];
  /** Each permission and its level, exactly. */
  permissions: Readonly<Record<string, string>>;
}

/** The largest token answer the runner reads. */
const MAX_TOKEN_ANSWER_BYTES = 256 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether GitHub granted no more than was asked: the permissions and the repositories. */
function grantedAsAsked(
  answer: Record<string, unknown>,
  request: NarrowTokenRequest,
): boolean {
  const grantable: Record<string, string> = {
    ...request.permissions,
    metadata: "read",
  };
  const permissions = answer.permissions;
  if (!isObject(permissions)) return false;
  for (const [name, level] of Object.entries(permissions)) {
    if (grantable[name] !== level) return false;
  }
  if (answer.repository_selection !== "selected") return false;
  if (answer.repositories === undefined) return true;
  const repositories = answer.repositories;
  return (
    Array.isArray(repositories) &&
    repositories.length === request.repositories.length &&
    repositories.every((r, i) => isObject(r) && r.name === request.repositories[i])
  );
}

/**
 * Mints one token for `request`. `label` names the token in errors ("the repository creation
 * token"); `fail` builds the error, so each token keeps its own error type.
 */
export async function mintNarrowToken(
  { appJwt, installationId, http }: NarrowTokenOptions,
  request: NarrowTokenRequest,
  label: string,
  fail: (message: string) => Error,
): Promise<string> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw fail("the installation id is not a positive number");
  }
  const answer = await http.post({
    path: `/app/installations/${installationId}/access_tokens`,
    token: await appJwt.sign(),
    body: {
      repositories: [...request.repositories],
      permissions: { ...request.permissions },
    },
    maxBytes: MAX_TOKEN_ANSWER_BYTES,
  });
  if (answer.status !== 201) {
    throw fail(`GitHub refused ${label} with ${answer.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(answer.body).toString("utf8"));
  } catch {
    throw fail("the token answer is not JSON");
  }
  if (!isObject(body) || typeof body.token !== "string" || body.token === "") {
    throw fail("the token answer holds no token");
  }
  if (!grantedAsAsked(body, request)) {
    throw fail(`GitHub granted ${label} more than was asked, so it is not used`);
  }
  return body.token;
}
