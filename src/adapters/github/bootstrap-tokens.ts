// The runner App's tokens for `BOOTSTRAP_TOKEN`'s access (D-358 lock (2), O-114). D-358 gives the
// runner App "Organization secrets: write" and "Actions: write"; only these tokens carry them, and
// only the register form's setup step and the two removal steps mint them (src/core/bootstrap-access.ts).
// Each is narrowed at creation through the shared mint (./narrow-tokens.ts), which refuses a token
// GitHub grants wider than asked:
//
// - The change token: `{"repositories":[<name>],"permissions":{"organization_secrets":"write",
//   "metadata":"read"}}`. GitHub's "Add selected repository to an organization secret" and
//   "Remove selected repository from an organization secret" need "Secrets" organization
//   permissions (write) and "Metadata" repository permissions (read), and the key for the first
//   in an installation token's `permissions` is `organization_secrets` (GitHub's REST docs, read
//   2026-11-07). Narrowed to the one repository, so it can add or remove only that repository.
// - The list token: `{"repositories":["foreman"],"permissions":{"organization_secrets":"read"}}`.
//   "List selected repositories for an organization secret" needs "Secrets" organization
//   permissions (read) and reads no repository. A token without `repositories` reaches every
//   repository of the installation, so it names the one repository the runner already reads its
//   settings from (D-345, O-109), for GitHub's metadata only.
// - The restart token: `{"repositories":[<name>],"permissions":{"actions":"write"}}`. "Create a
//   workflow dispatch event" needs "Actions" repository permissions (write).
//
// None of these can read a secret's value (GitHub's API never returns one) or delete a
// repository. A token with "Secrets" organization write could also create, replace or delete an
// organization secret, which is why it is minted for one call and never kept. Until the runner App
// is registered through the new-credentials gate (D-178), the runner's port refuses with
// `NotBuiltError` (flows/lib/compose.ts), and tests pass a fake. Nothing here logs.
import { PLATFORM_SETTINGS } from "../../core/register-project.ts";
import { isRepositoryName } from "../../core/bootstrap-access.ts";
import { mintNarrowToken, type NarrowTokenOptions } from "./narrow-tokens.ts";

/** The change token's permissions, exactly. */
export const SECRETS_CHANGE_PERMISSIONS = {
  organization_secrets: "write",
  metadata: "read",
} as const;

/** The list token's permissions and its one repository, exactly. */
export const SECRETS_LIST_PERMISSIONS = { organization_secrets: "read" } as const;
export const SECRETS_LIST_REPOSITORIES = [
  PLATFORM_SETTINGS.repository.split("/")[1] as string,
] as const;

/** The restart token's permissions, exactly. */
export const RESTART_PERMISSIONS = { actions: "write" } as const;

export interface BootstrapTokens {
  /** Adds or removes `didi-build/<name>` on the secret's list, and nothing else. Never logged. */
  secretsChange(name: string): Promise<string>;
  /** Lists the secret's repositories. Never logged. */
  secretsList(): Promise<string>;
  /** Starts a workflow on `didi-build/<name>`. Never logged. */
  restart(name: string): Promise<string>;
}

/** A mint GitHub refused, or a token it granted wider than asked. Names the step, never a token. */
export class BootstrapTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapTokenError";
  }
}

export function createBootstrapTokens(options: NarrowTokenOptions): BootstrapTokens {
  const fail = (message: string) => new BootstrapTokenError(message);
  const one = (name: string): readonly string[] => {
    if (!isRepositoryName(name)) throw fail("not a repository name");
    return [name];
  };
  return {
    secretsChange: async (name) =>
      mintNarrowToken(
        options,
        { repositories: one(name), permissions: SECRETS_CHANGE_PERMISSIONS },
        "the secret access token",
        fail,
      ),
    secretsList: () =>
      mintNarrowToken(
        options,
        {
          repositories: SECRETS_LIST_REPOSITORIES,
          permissions: SECRETS_LIST_PERMISSIONS,
        },
        "the secret list token",
        fail,
      ),
    restart: async (name) =>
      mintNarrowToken(
        options,
        { repositories: one(name), permissions: RESTART_PERMISSIONS },
        "the Bootstrap restart token",
        fail,
      ),
  };
}
