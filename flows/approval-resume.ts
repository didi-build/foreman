// The approval resume step (build plan M3.1, M0.4, D-170): the step after a Windmill `suspend`
// on a gate request's approval page. It reads Windmill's resume value and records the answer on
// the gate request through the library, verbatim. A gate request closes once, so a repeated
// resume records one decision. Under the kill switch or in dry run it writes nothing and returns
// the reply, so Windmill's job result keeps it. Turning a reply into a decision is
// `deps.approvals`, which is not decided yet and refuses in production.
import { createLibrary, LibraryError } from "../src/core/library.ts";
import { readApprovalReply, type ApprovalReply } from "./lib/approval.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { dryRunOn, killSwitchOn } from "./lib/switches.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface ApprovalResumeInput {
  gateRequestId: string;
  /** Windmill's `resume` value. */
  resume: unknown;
  /** Windmill's `approvers` value. */
  approvers: unknown;
}

export type ApprovalResumeResult =
  | { outcome: "refused"; reason: "kill_switch" | "dry_run"; reply: ApprovalReply }
  | { outcome: "no_gate_request" | "already_closed" }
  | { outcome: "recorded"; decisionId: string };

export async function run(
  deps: FlowDeps,
  input: ApprovalResumeInput,
): Promise<ApprovalResumeResult> {
  const reply = readApprovalReply(input.resume, input.approvers);
  if (await killSwitchOn(deps.store))
    return { outcome: "refused", reason: "kill_switch", reply };
  if (await dryRunOn(deps.store))
    return { outcome: "refused", reason: "dry_run", reply };
  const gate = await deps.store.getGateRequest(input.gateRequestId);
  if (!gate) return { outcome: "no_gate_request" };
  if (gate.status !== "open") return { outcome: "already_closed" };
  const answer = await deps.approvals.answerFor(gate, reply);
  try {
    const decision = await createLibrary(deps).answerGateRequest(gate.id, answer);
    return { outcome: "recorded", decisionId: decision.id };
  } catch (error) {
    // Another resume closed it between the read and the write; the store kept one answer.
    if (error instanceof LibraryError) return { outcome: "already_closed" };
    throw error;
  }
}

export const main = (input: ApprovalResumeInput): Promise<ApprovalResumeResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
