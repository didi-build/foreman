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
// (another permission, another level, or all repositories) is refused too, and not used. The
// mint and that refusal are shared with the Bootstrap access tokens (./narrow-tokens.ts, O-114).
//
// The real minting signs with the runner App's private key, which only the runner holds, read on
// the first token (flows/lib/compose.ts, O-125); tests pass a fake. The token is never kept or
// logged.
import {
  mintNarrowToken,
  type GitHubAppJwt,
  type NarrowTokenOptions,
} from "./narrow-tokens.ts";

export type { GitHubAppJwt };

/** The repositories the creation token may reach: the template only. */
export const CREATION_TOKEN_REPOSITORIES = ["launchpad"] as const;

/** The permissions the creation token asks for, exactly (D-346). */
export const CREATION_TOKEN_PERMISSIONS = {
  contents: "read",
  repository_creation: "write",
} as const;

export interface RepositoryCreationTokens {
  /** A new installation token for the template only, with exactly the two permissions. Never logged. */
  mint(): Promise<string>;
}

/** A mint GitHub refused, or a token it granted wider than asked. Names the step, never a token. */
export class RepositoryCreationTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryCreationTokenError";
  }
}

export type RepositoryCreationTokenOptions = NarrowTokenOptions;

/** The creation token, through the shared narrow mint and its wider-grant refusal (./narrow-tokens.ts). */
export function createRepositoryCreationTokens(
  options: RepositoryCreationTokenOptions,
): RepositoryCreationTokens {
  return {
    mint: () =>
      mintNarrowToken(
        options,
        {
          repositories: CREATION_TOKEN_REPOSITORIES,
          permissions: CREATION_TOKEN_PERMISSIONS,
        },
        "the repository creation token",
        (message) => new RepositoryCreationTokenError(message),
      ),
  };
}
