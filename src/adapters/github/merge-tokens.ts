// The runner App's merge token (D-127, D-365, D-381). Only the runner's squash merge
// (./runner-github.ts) mints it, for one merge. The installation token request names exactly one
// repository of `didi-build` and one permission (GitHub's `repositories` and `permissions`
// parameters):
//
//   {"repositories":["<name>"],"permissions":{"contents":"write"}}
//
// D-365 gave the runner App Contents write because GitHub's merge call needs it, and said each
// merge token is narrowed to one repository and `contents: write`. GitHub's "Merge a pull request"
// (`PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`) names "Contents" repository permissions
// (write) for fine-grained and installation tokens; it is not confirmed against a real merge yet
// (O-127). The runner App has no Pull requests write, and this port never asks for it.
//
// A port of its own, apart from the read tokens (./runner-read-tokens.ts), so no read can mint a
// token with write: the read port asks only for the read level, and this one only for this one
// permission. A repository that is not exactly `didi-build/<name>` is refused before anything is
// signed or sent. A refused mint, and a token GitHub grants wider than asked, are refused by the
// shared mint (./narrow-tokens.ts) and never tried again. The runner signs with its App's private
// key, read on the first token (flows/lib/compose.ts, O-125); tests pass a fake. Nothing here
// logs, and the token is never kept.
import {
  GITHUB_ORGANIZATION,
  organizationRepositoryName,
} from "../../core/bootstrap-access.ts";
import { mintNarrowToken, type NarrowTokenOptions } from "./narrow-tokens.ts";

/** The merge token's permissions, exactly (D-365). */
export const MERGE_TOKEN_PERMISSIONS = { contents: "write" } as const;

export interface RunnerMergeTokens {
  /** A new installation token for `repository` only, with `contents: write`. Never logged. */
  mint(repository: string): Promise<string>;
}

/** A request the merge token refuses, or a refused mint. Never names a token. */
export class RunnerMergeTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerMergeTokenError";
  }
}

export function createRunnerMergeTokens(
  options: NarrowTokenOptions,
): RunnerMergeTokens {
  const fail = (message: string) => new RunnerMergeTokenError(message);
  return {
    async mint(repository) {
      const name = organizationRepositoryName(repository);
      if (name === null) {
        throw fail(
          `The runner App's merge token is only for a repository of ${GITHUB_ORGANIZATION}`,
        );
      }
      return mintNarrowToken(
        options,
        { repositories: [name], permissions: MERGE_TOKEN_PERMISSIONS },
        "the runner App's merge token",
        fail,
      );
    },
  };
}
