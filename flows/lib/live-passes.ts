// The passes the reconcile flow runs with `dry_run` off, while the live reconcile pass is not
// built (M2.4 stops on `dry_run` false, which the pass reports as `live_mode_not_built`). The
// merge pass merges what QA passed and recovers a merge whose move was not written (M3.3, O-31).
// The staging pass then checks each merged item on staging and recovers its moves, its escalation
// and its dependents' release (M3.4, O-37), and reports the items that have waited past
// `staging_deploy_attention_after_minutes` with no deploy recorded (D-225, O-40). The escalation
// pass then takes each escalated item on once the Council or Didi has answered (M3.5,
// src/core/escalations.ts): back where it was escalated from with the counters reset, or on to
// Didi with a gate request. The follow-up pass then opens the follow-up Council question on each
// reversal whose gate request Didi has answered (D-234, ./council-runs.ts). The Council pass then
// starts a Council run for each open question
// that has none, or sends a question whose runs gave no usable answer to Didi (D-228, D-229,
// ./council-runs.ts). The redo pass then sends each stale item whose Council redo stands back to
// the start of its track, cancelling its runs first (D-231), or opens a merged item's rework item
// (D-233). The Triage pass then takes each idea in Plan accepted to Triage and gives each idea in
// Triage its run, its re-run, or the Council after two runs with no usable answer (M3.6,
// ./triage-runs.ts). The hold release pass then clears the hold flag of each held item whose
// release request Didi approved, when the approval step could not (a switch held it, or it was cut
// short; D-269, src/core/hold-release.ts). The option capture pass then captures each design
// item's exploration options once CI has rendered them at its PR head, opens Didi's
// visual-approval request and asks again for the Designer report's move into Waiting for Didi
// (O-88, ./option-capture.ts). The plan approval pass runs before the Triage pass: for
// each idea in Submitted or Council planning with a plan from the planning chat, it opens Didi's
// plan-approval request for the latest plan, or takes the move Didi's answer calls for (D-266,
// src/core/plans.ts), so an idea Didi approved goes on to Triage in the same pass. Last, the builder runs pass starts the fix round of each item a failed
// QA round, a staging check, a refused done report or an answered escalation sent back, and
// resumes a builder run queued after `usage_exhausted` (O-41, O-43). It runs after the staging and
// escalation passes, so an escalation that pass recovers is taken first. Under any other stop,
// none runs.
import { createEscalations, type EscalationStep } from "../../src/core/escalations.ts";
import {
  createHoldReleases,
  type HoldReleaseStep,
} from "../../src/core/hold-release.ts";
import { createMerges, type MergeResult } from "../../src/core/merge.ts";
import type { ReconcileReport } from "../../src/core/reconcile.ts";
import {
  createStaging,
  type StagingDeployWait,
  type StagingResult,
} from "../../src/core/staging.ts";
import { startBuilderRuns, type BuilderRunStart } from "./builder-runs.ts";
import { optionCapturePass, type OptionCapturePassStep } from "./option-capture.ts";
import { triagePass, type TriagePassStep } from "./triage-runs.ts";
import { createPlanApprovals, type PlanApprovalStep } from "../../src/core/plans.ts";
import type { FlowDeps } from "./compose.ts";
import type { FollowUpStep } from "../../src/core/council.ts";
import {
  councilPass,
  followUpPass,
  redoPass,
  type CouncilPassStep,
  type RedoPassStep,
} from "./council-runs.ts";

export interface LivePasses {
  merged: { nodeId: string; result: MergeResult }[] | null;
  verified: StagingResult[] | null;
  /** Items in Verifying on staging past the wait setting with no deploy, for the attention list. */
  stagingWaits: StagingDeployWait[] | null;
  /** What the escalation pass did for each escalated item (M3.5). */
  escalations: EscalationStep[] | null;
  /** The follow-up Council questions opened after Didi's answers to reversals (D-234). */
  followUps: FollowUpStep[] | null;
  /** What the Council pass did for each open Council question (D-228, D-229). */
  councilRuns: CouncilPassStep[] | null;
  /** What the redo pass did for each stale item with a Council redo standing (D-231). */
  redos: RedoPassStep[] | null;
  /** What the plan approval pass did for each idea with a plan from the planning chat (D-266). */
  plans: PlanApprovalStep[] | null;
  /** What the Triage pass did for each idea in Plan accepted or Triage (M3.6). */
  triage: TriagePassStep[] | null;
  /** What the hold release pass did for each held item with an answered release request (D-269). */
  holdReleases: HoldReleaseStep[] | null;
  /** What the option capture pass did for each design item in exploration (O-88). */
  optionCaptures: OptionCapturePassStep[] | null;
  /** The builder runs due with no move, and what their dispatch did. */
  builderRuns: BuilderRunStart[] | null;
  /** Settings the passes needed and could not read. */
  problems: string[];
}

export async function runLivePasses(
  deps: FlowDeps,
  stopped: ReconcileReport["stopped"],
): Promise<LivePasses> {
  if (stopped !== "live_mode_not_built") {
    return {
      merged: null,
      verified: null,
      stagingWaits: null,
      escalations: null,
      followUps: null,
      councilRuns: null,
      redos: null,
      plans: null,
      triage: null,
      holdReleases: null,
      optionCaptures: null,
      builderRuns: null,
      problems: [],
    };
  }
  const merged = await createMerges(deps).mergeReady();
  const staging = createStaging({ ...deps, checker: deps.stagingChecker });
  const verified = await staging.verifyReady();
  const { waits, problem } = await staging.deployWaits(verified);
  const escalations = await createEscalations(deps).resolveAll();
  const followUps = await followUpPass(deps);
  const councilRuns = await councilPass(deps);
  const redos = await redoPass(deps);
  const planApprovals = createPlanApprovals(deps);
  const plans: PlanApprovalStep[] = [];
  for (const ideaId of await planApprovals.pending()) {
    plans.push(await planApprovals.step(ideaId));
  }
  const triage = await triagePass(deps);
  const releases = createHoldReleases(deps);
  const holdReleases: HoldReleaseStep[] = [];
  for (const nodeId of await releases.pending()) {
    holdReleases.push(await releases.release(nodeId));
  }
  const optionCaptures = await optionCapturePass(deps);
  const builderRuns = await startBuilderRuns(deps);
  return {
    merged,
    verified,
    stagingWaits: waits,
    escalations,
    followUps,
    councilRuns,
    redos,
    plans,
    triage,
    holdReleases,
    optionCaptures,
    builderRuns,
    problems: problem ? [problem] : [],
  };
}
