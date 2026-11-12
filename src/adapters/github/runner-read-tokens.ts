// The runner App's read-only installation tokens (D-267, D-365, O-125): the real `RunnerAppTokens`
// port of ./runner-app-tokens.ts. Each token is minted through the shared narrow mint
// (./narrow-tokens.ts), signed with the runner App's own key, for exactly one repository of
// `didi-build` and exactly one permission at the read level:
//
//   {"repositories":["<name>"],"permissions":{"contents":"read"}}
//   {"repositories":["<name>"],"permissions":{"actions":"read"}}
//
// A repository that is not exactly `didi-build/<name>` with a name GitHub allows
// (`organizationRepositoryName`, narrower than `REPOSITORY`), and a permission that is not one of
// the two, are refused before anything is signed or sent. A refused mint, and a
// token GitHub grants wider than asked, are refused by the shared mint and never tried again.
//
// Kept apart from ./runner-app-tokens.ts, which the repo map and QA fetch images copy as it is, so
// those images gain no file. Nothing here logs, and the token is never kept.
import {
  GITHUB_ORGANIZATION,
  organizationRepositoryName,
} from "../../core/bootstrap-access.ts";
import { mintNarrowToken, type NarrowTokenOptions } from "./narrow-tokens.ts";
import type {
  RunnerAppTokenRequest,
  RunnerAppTokens,
  RunnerReadPermission,
} from "./runner-app-tokens.ts";

/** The two read permissions of D-267, each minted on its own. */
export const RUNNER_READ_PERMISSIONS: readonly RunnerReadPermission[] = [
  "contents",
  "actions",
];

/** A request the runner App's read tokens refuse, or a refused mint. Never names a token. */
export class RunnerAppTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerAppTokenError";
  }
}

export function createRunnerAppTokens(options: NarrowTokenOptions): RunnerAppTokens {
  const fail = (message: string) => new RunnerAppTokenError(message);
  return {
    async mint({ repository, permission }: RunnerAppTokenRequest) {
      const name = organizationRepositoryName(repository);
      if (name === null) {
        throw fail(
          `The runner App's read token is only for a repository of ${GITHUB_ORGANIZATION}`,
        );
      }
      if (!RUNNER_READ_PERMISSIONS.includes(permission)) {
        throw fail("The runner App's read token is only for contents or actions");
      }
      return mintNarrowToken(
        options,
        { repositories: [name], permissions: { [permission]: "read" } },
        `the runner App's ${permission} read token`,
        fail,
      );
    },
  };
}
