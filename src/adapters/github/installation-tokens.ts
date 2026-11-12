// The port that mints a run's GitHub installation token (ADR 0106 section 5, ADR 0112, D-156,
// D-159, D-178), and its real implementation (D-365, O-125). The runner holds each role's GitHub
// App key; per run it mints a token for one repository from the role's own App: Developer and
// Designer with write access for the agent pod, QA read-only for its fetch step only (D-184).
// Council and Triage get none. GitHub caps a token at one hour.
//
// Each mint signs with the role's own App key (./app-jwt.ts), finds that App's installation for the
// run's repository with `GET /repos/{owner}/{repo}/installation` (GitHub's "Get a repository
// installation for the authenticated app", which takes the App's JWT), and mints through the
// shared narrow mint (./narrow-tokens.ts) for exactly that one repository and the role's
// permissions below. The installation's `id` must be a positive whole number and its account, when
// the answer names one, `didi-build`. A role that gets no token, an access that is not the role's,
// and a repository that is not exactly `didi-build/<name>` with a name GitHub allows
// (`organizationRepositoryName`, narrower than `REPOSITORY`) are refused before anything is signed
// or sent.
// A 404 (the App is not installed there), any other status, an answer that is not JSON or holds no
// usable installation, a refused mint and a token granted wider than asked are each refused with
// fixed text naming the App, and nothing is tried again.
//
// The token is passed on to `start` and never kept or logged. Revoking it when the run ends (ADR
// 0106 section 5 and check 7) is not built here (O-125).
import {
  GITHUB_ORGANIZATION,
  organizationRepositoryName,
} from "../../core/bootstrap-access.ts";
import type { AgentRole } from "../../core/store.ts";
import { GITHUB_APP_NAMES } from "./app-jwt.ts";
import { mintNarrowToken, type GitHubAppJwt } from "./narrow-tokens.ts";
import type { GitHubPostHttp } from "./post-http.ts";
import type { GitHubHttp } from "./runner-app-tokens.ts";

/** The roles whose runs get a token. */
export type TokenRole = Extract<AgentRole, "developer" | "designer" | "qa">;

export const TOKEN_ROLES: readonly TokenRole[] = ["developer", "designer", "qa"];

export interface InstallationTokenRequest {
  role: TokenRole;
  /** `owner/name`: the token works for this repository only. */
  repository: string;
  /** `write` for the Developer and Designer, `read` for QA (D-159). */
  access: "read" | "write";
  /** The run the token is for, for the runner's own records. */
  runId: string;
}

export interface InstallationTokens {
  /** A new installation token for one run and one repository. Never logged. */
  mint(request: InstallationTokenRequest): Promise<string>;
}

/** Each role's one access level (D-159, O-60). */
export const TOKEN_ACCESS: Readonly<Record<TokenRole, "read" | "write">> = {
  developer: "write",
  designer: "write",
  qa: "read",
};

/**
 * Exactly what each role's token asks for (D-365, O-125). The Developer and Designer push their
 * run's branch (contents write, D-235, D-365) and open, comment on and close their own pull
 * requests (pull requests write, D-235, D-318). QA's token is used only by its fetch step, which
 * downloads the head commit's archive (contents read, D-184, O-124); UNCONFIRMED (O-125) whether
 * it should also carry the pull requests read that D-365 gives the QA App.
 */
export const INSTALLATION_TOKEN_PERMISSIONS: Readonly<
  Record<TokenRole, Readonly<Record<string, string>>>
> = {
  developer: { contents: "write", pull_requests: "write" },
  designer: { contents: "write", pull_requests: "write" },
  qa: { contents: "read" },
};

/** A request refused, a lookup or a mint GitHub refused. Names the App, never a token. */
export class InstallationTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationTokenError";
  }
}

export interface InstallationTokenOptions {
  /** Each role's own App, signing with that App's key and id. */
  apps: Readonly<Record<TokenRole, GitHubAppJwt>>;
  /** The installation lookup, with the App's JWT. */
  http: GitHubHttp;
  /** The mint, with the App's JWT. */
  post: GitHubPostHttp;
}

/** The largest installation answer the runner reads. */
const MAX_INSTALLATION_ANSWER_BYTES = 64 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The role App's installation id for `didi-build/<name>`, or a refusal naming the App. */
async function installationIdOf(
  { http }: InstallationTokenOptions,
  appJwt: GitHubAppJwt,
  name: string,
  app: string,
): Promise<number> {
  const fail = (message: string) => new InstallationTokenError(message);
  const answer = await http.get({
    path: `/repos/${GITHUB_ORGANIZATION}/${name}/installation`,
    token: await appJwt.sign(),
    accept: "json",
    maxBytes: MAX_INSTALLATION_ANSWER_BYTES,
  });
  if (answer.status === 404) {
    throw fail(`The ${app} is not installed on the repository`);
  }
  if (answer.status !== 200) {
    throw fail(`GitHub refused the ${app}'s installation lookup with ${answer.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(answer.body).toString("utf8"));
  } catch {
    throw fail(`The ${app}'s installation answer is not JSON`);
  }
  if (!isObject(body) || !Number.isSafeInteger(body.id) || (body.id as number) <= 0) {
    throw fail(`The ${app}'s installation answer holds no installation id`);
  }
  if (
    body.account !== undefined &&
    (!isObject(body.account) || body.account.login !== GITHUB_ORGANIZATION)
  ) {
    throw fail(`The ${app}'s installation is not on ${GITHUB_ORGANIZATION}`);
  }
  return body.id as number;
}

export function createInstallationTokens(
  options: InstallationTokenOptions,
): InstallationTokens {
  return {
    async mint({ role, repository, access }) {
      if (!TOKEN_ROLES.includes(role)) {
        throw new InstallationTokenError(
          "Only Developer, Designer and QA runs get a GitHub token",
        );
      }
      const app = GITHUB_APP_NAMES[role];
      const fail = (message: string) => new InstallationTokenError(message);
      if (access !== TOKEN_ACCESS[role]) {
        throw fail(`The ${app}'s run token is ${TOKEN_ACCESS[role]} only`);
      }
      const name = organizationRepositoryName(repository);
      if (name === null) {
        throw fail(
          `The ${app}'s run token is only for a repository of ${GITHUB_ORGANIZATION}`,
        );
      }
      const appJwt = options.apps[role];
      const installationId = await installationIdOf(options, appJwt, name, app);
      return mintNarrowToken(
        { appJwt, installationId, http: options.post },
        { repositories: [name], permissions: INSTALLATION_TOKEN_PERMISSIONS[role] },
        `the ${app}'s run token`,
        fail,
      );
    },
  };
}
