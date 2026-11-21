// The runner App's settings write token (D-443, ADR 0118 appendix A, O-161). Only the New project
// form's settings step mints it, for one create-only write of `projects/<slug>.json`
// (./project-settings.ts). The installation token request names exactly the settings repository
// and one permission:
//
//   {"repositories":["foreman-projects"],"permissions":{"contents":"write"}}
//
// The runner App already holds Contents read and write for its merges (D-365) and is installed on
// every repository of `didi-build` (D-347), so this is an existing permission in a new place, and
// the App gains none (D-443). A port of its own, with no parameter, so it can mint for no other
// repository: the merge token (./merge-tokens.ts) is the only other `contents: write` mint, and
// no read can reach this one. A refused mint, and a token GitHub grants wider than asked, are
// refused by the shared mint (./narrow-tokens.ts) and never tried again, with this request or a
// wider one. The runner signs with its App's private key, read on the first token
// (flows/lib/compose.ts, O-125); tests pass a fake. Nothing here logs, and the token is never kept.
import { mintNarrowToken, type NarrowTokenOptions } from "./narrow-tokens.ts";

/** The one repository the token may reach: the settings repository (D-442). */
export const SETTINGS_WRITE_REPOSITORIES = ["foreman-projects"] as const;

/** The token's permissions, exactly (D-443). */
export const SETTINGS_WRITE_PERMISSIONS = { contents: "write" } as const;

export interface SettingsWriteTokens {
  /** A new installation token for `didi-build/foreman-projects` only, `contents: write`. Never logged. */
  mint(): Promise<string>;
}

/** A refused mint, or a token granted wider than asked. Names the step, never a token. */
export class SettingsWriteTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsWriteTokenError";
  }
}

export function createSettingsWriteTokens(
  options: NarrowTokenOptions,
): SettingsWriteTokens {
  return {
    mint: () =>
      mintNarrowToken(
        options,
        {
          repositories: SETTINGS_WRITE_REPOSITORIES,
          permissions: SETTINGS_WRITE_PERMISSIONS,
        },
        "the settings write token",
        (message) => new SettingsWriteTokenError(message),
      ),
  };
}
