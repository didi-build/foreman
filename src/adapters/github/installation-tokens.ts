// The port that mints a run's GitHub installation token (ADR 0106 section 5, ADR 0112, D-156,
// D-159, D-178). The runner holds each role's GitHub App key; per run it mints a token for one
// repository from the role's App: Developer and Designer with write access for the agent pod, QA
// read-only for its fetch step only. Council and Triage get none. GitHub caps a token at one hour.
//
// The real implementation needs the Apps, which are registered at M3 (D-178) through the
// new-credentials gate. Until then the runner's port refuses (flows/lib/compose.ts), and tests
// pass a fake. A token is passed on to `start` and never kept or logged.
import type { AgentRole } from "../../core/store.ts";

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
