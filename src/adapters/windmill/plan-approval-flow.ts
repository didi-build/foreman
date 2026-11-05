// The state API's port to start the plan-approval flow (D-273 (2), D-274, D-283). After `POST
// /plans` records a submission, the state API starts the Windmill flow `f/foreman/plan_approval`
// for that idea, so Didi's request opens at once instead of on the next reconcile pass. The
// reconcile pass's plan approval step stays as the safety net: if the start fails, the submission
// still stands and the pass opens the request later.
//
// The credential is narrow: a Windmill token that can start only this one flow, created by Didi
// at first hosting (a new-credentials gate) and read by the state API from the secret path below.
// The call goes through the shared Windmill egress proxy (D-284, D-328, ./client.ts). Until the
// token exists the adapter refuses with `NotBuiltError`. Tests use ./fake-flow-start.ts.
import {
  entryArgs,
  NotBuiltError,
  windmillScripts,
  type WindmillClientOptions,
  type WindmillTarget,
} from "./client.ts";

/** The secret path of the state API's Windmill credential (D-273 (2)). */
export const WINDMILL_PLAN_APPROVAL_TOKEN_PATH =
  "platform/state-api/windmill-plan-approval-token";

/** The one Windmill flow that credential may start (flows/windmill.yaml). */
export const PLAN_APPROVAL_FLOW_PATH = "f/foreman/plan_approval";

/** Starts the plan-approval flow for one idea. Resolves once Windmill has accepted the start. */
export interface PlanApprovalFlow {
  start(ideaId: string): Promise<void>;
}

/**
 * The Windmill binding. `token` is the credential read from its secret path, or null while it
 * does not exist; then every start is refused. `seams` is for tests only.
 */
export function windmillPlanApprovalFlow(
  token: string | null,
  target: WindmillTarget,
  seams: Pick<WindmillClientOptions, "ca" | "timeoutMs"> = {},
): PlanApprovalFlow {
  if (token === null) {
    return {
      start: async () => {
        throw new NotBuiltError(
          "Starting the plan-approval flow needs the state API's Windmill credential, created at first hosting (D-283)",
        );
      },
    };
  }
  const scripts = windmillScripts({ target, token, ...seams });
  return {
    start: (ideaId) => scripts.start(PLAN_APPROVAL_FLOW_PATH, entryArgs({ ideaId })),
  };
}
