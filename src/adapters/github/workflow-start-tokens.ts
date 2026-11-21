// The runner App's workflow start token (D-443, ADR 0118 appendix C step 4, O-161). Only the New
// project form's start step mints it, once per run, for exactly two calls: starting the Platform
// and Infra apply workflows on `didi-build/foreman`'s main (./project-workflows.ts). The
// installation token request names exactly Foreman's repository and one permission:
//
//   {"repositories":["foreman"],"permissions":{"actions":"write"}}
//
// GitHub's "Create a workflow dispatch event" needs "Actions" repository permissions (write). The
// runner App already holds it for Bootstrap's restart (D-358), so this is an existing permission in
// a new place (D-443). The permission could also cancel, re-run or delete runs and turn workflows
// off; the code that holds this token makes only the two start calls, and nothing else gets it. A
// port of its own, with no parameter, so it can mint for no other repository (Bootstrap's restart
// token has its own port, ./bootstrap-tokens.ts). A refused mint, and a token GitHub grants wider
// than asked, are refused by the shared mint (./narrow-tokens.ts) and never tried again. The runner
// signs with its App's private key, read on the first token (flows/lib/compose.ts, O-125); tests
// pass a fake. Nothing here logs, and the token is never kept.
import { mintNarrowToken, type NarrowTokenOptions } from "./narrow-tokens.ts";

/** The one repository the token may reach: Foreman's own, where the two workflows live. */
export const WORKFLOW_START_REPOSITORIES = ["foreman"] as const;

/** The token's permissions, exactly (D-443). */
export const WORKFLOW_START_PERMISSIONS = { actions: "write" } as const;

export interface WorkflowStartTokens {
  /** A new installation token for `didi-build/foreman` only, `actions: write`. Never logged. */
  mint(): Promise<string>;
}

/** A refused mint, or a token granted wider than asked. Names the step, never a token. */
export class WorkflowStartTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStartTokenError";
  }
}

export function createWorkflowStartTokens(
  options: NarrowTokenOptions,
): WorkflowStartTokens {
  return {
    mint: () =>
      mintNarrowToken(
        options,
        {
          repositories: WORKFLOW_START_REPOSITORIES,
          permissions: WORKFLOW_START_PERMISSIONS,
        },
        "the workflow start token",
        (message) => new WorkflowStartTokenError(message),
      ),
  };
}
