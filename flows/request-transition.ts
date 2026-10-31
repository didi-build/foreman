// The transition flow (build plan M3.1, architecture section 2.4): one run asks the library for
// exactly one move, for an event, a bot report, a human or a timeout. Which moves exist and what
// each needs come from the contracts and guards; the flow only passes the request on. The trigger
// carries its own id, and the library takes a trigger id once, so a duplicate trigger writes one
// transition row, applied or dry run. The library also refuses under the kill switch and writes
// dry-run rows while `dry_run` is on.
import { createLibrary, type TransitionRequest } from "../src/core/library.ts";
import type { Transition } from "../src/core/store.ts";
import { withFlowDeps, type FlowDeps } from "./lib/compose.ts";
import { killSwitchOn } from "./lib/switches.ts";
import { windmillEnvironment } from "./lib/windmill.ts";

export interface RequestTransitionInput extends Omit<TransitionRequest, "trigger"> {
  /** The reconcile pass has its own flow. */
  trigger: { kind: Exclude<Transition["triggerKind"], "reconcile">; ref: string };
}

export interface RequestTransitionResult {
  outcome: "applied" | "planned" | "noop" | "rejected" | "refused";
  reason?: string;
  transitionId?: string;
  failedGuards: string[];
}

export async function run(
  deps: FlowDeps,
  input: RequestTransitionInput,
): Promise<RequestTransitionResult> {
  if (await killSwitchOn(deps.store)) {
    return { outcome: "refused", reason: "kill_switch", failedGuards: [] };
  }
  const result = await createLibrary(deps).requestTransitionOnce(input);
  return {
    outcome: result.outcome,
    reason: result.reason,
    transitionId: result.transitionId,
    failedGuards: result.guardReport.filter((c) => !c.pass).map((c) => c.name),
  };
}

export const main = (input: RequestTransitionInput): Promise<RequestTransitionResult> =>
  withFlowDeps(windmillEnvironment(), (deps) => run(deps, input));
