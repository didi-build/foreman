// The state API's port to start the plan-approval flow (D-273 (2), D-274). After `POST /plans`
// records a submission, the state API starts the Windmill flow `f/foreman/plan_approval` for that
// idea, so Didi's request opens at once instead of on the next reconcile pass. The reconcile
// pass's plan approval step stays as the safety net: if the start fails, the submission still
// stands and the pass opens the request later.
//
// The credential is narrow: a Windmill token that can start only this one flow, created by Didi
// at first hosting (a new-credentials gate) and read by the state API from the secret path below.
// Until it exists, and until the Windmill call is written and checked against Windmill's own API
// at first hosting, the real adapter refuses with `NotBuiltError`. Nothing here guesses at
// Windmill's API. Tests use ./fake-plan-approval-flow.ts.

/** The secret path of the state API's Windmill credential (D-273 (2)). */
export const WINDMILL_PLAN_APPROVAL_TOKEN_PATH =
  "platform/state-api/windmill-plan-approval-token";

/** The one Windmill flow that credential may start (flows/windmill.yaml). */
export const PLAN_APPROVAL_FLOW_PATH = "f/foreman/plan_approval";

/** Starts the plan-approval flow for one idea. Resolves once Windmill has accepted the start. */
export interface PlanApprovalFlow {
  start(ideaId: string): Promise<void>;
}

/** A part the state API cannot use yet. The message says what it waits on, never a value. */
export class NotBuiltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotBuiltError";
  }
}

/**
 * The Windmill binding. `token` is the credential read from its secret path, or null while it
 * does not exist. Either way it refuses today: the call itself is written at first hosting.
 */
export function windmillPlanApprovalFlow(token: string | null): PlanApprovalFlow {
  return {
    start: async () => {
      throw new NotBuiltError(
        token === null
          ? "Starting the plan-approval flow needs the state API's Windmill credential, created at first hosting (D-273)"
          : "The Windmill call that starts the plan-approval flow is written and checked against Windmill's API at first hosting (D-273)",
      );
    },
  };
}
