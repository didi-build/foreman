// What the reconcile flow does with `dry_run` off, after the pass (src/core/reconcile.ts) has
// polled GitHub and planned steps 2 to 4 with the same code as in dry run (O-103). The kill
// switch stops the pass before any of this, and then only the cancel pass runs
// (./cancel-runs.ts, D-202). In live mode, in this order:
//
// 1. Release, dispatch and advance from evidence, the steps 2 to 4 of architecture section 2.5:
//    the moves and runs the plan found due (./reconcile-steps.ts). A released item's first run
//    starts at once, and QA's run starts once an item advances into review.
// 2. The merge pass merges what QA passed and recovers a merge whose move was not written (M3.3,
//    O-31): the rest of step 4.
// 3. The merged-change pass asks the Council whether each open item that touches the same design
//    feature folder as a merged item is still needed (D-308 (3), src/core/still-needed.ts), once
//    per pair, before the Council pass starts the runs.
// 4. The staging pass checks each merged item on staging and recovers its moves, its escalation
//    and its dependents' release (M3.4, O-37): the staging part of step 4. It reports the items
//    that have waited past `staging_deploy_attention_after_minutes` with no deploy recorded
//    (D-225, O-40), and each item a node's Done frees gets its first run at once (D-329).
// 5. The escalation pass takes each escalated item on once the Council or Didi has answered (M3.5,
//    src/core/escalations.ts): back where it was escalated from with the counters reset, or on to
//    Didi with a gate request. An item back in a ready state gets its first run at once.
// 6. The follow-up pass opens the follow-up Council question on each reversal whose gate request
//    Didi has answered (D-234, ./council-runs.ts).
// 7. The Council pass starts a Council run for each open question that has none, or sends a
//    question whose runs gave no usable answer to Didi (D-228, D-229, ./council-runs.ts).
// 8. The redo pass sends each stale item whose Council redo stands back to the start of its
//    track, cancelling its runs first (D-231), or opens a merged item's rework item (D-233); the
//    item back at the start, or the rework item, gets its first run at once.
// 9. The cancel pass opens Didi's request to confirm each Council stop on a plan Didi approved,
//    cancels each work item a cancel stands on once no run is active on it, and then moves the
//    idea to Rejected (D-308, ./council-runs.ts).
// 10. The close pass starts the close-only run of each cancelled item's pull request that has had
//    none, which a refused start, or a pass cut short, left due (D-318, ./close-runs.ts).
// 11. The plan approval pass, for each idea in Submitted or Council planning with a plan from the
//    planning chat, opens Didi's plan-approval request for the latest plan, or takes the move
//    Didi's answer calls for (D-266, src/core/plans.ts), so an idea Didi approved goes on to Triage
//    in the same pass.
// 12. The Triage pass takes each idea in Plan accepted to Triage and gives each idea in Triage its
//    run, its re-run, or the Council after two runs with no usable answer (M3.6,
//    ./triage-runs.ts).
// 13. The hold release pass clears the hold flag of each held item whose release request Didi
//    approved, when the approval step could not (a switch held it, or it was cut short; D-269,
//    src/core/hold-release.ts), and the released item gets its first run at once.
// 14. The option capture pass captures each design item's exploration options once CI has
//    rendered them at its PR head, opens Didi's visual-approval request and asks again for the
//    Designer report's move into Waiting for Didi (O-88, ./option-capture.ts).
// 15. Last, the builder runs pass starts the fix round of each item a failed QA round, a staging
//    check, a refused done report or an answered escalation sent back, and resumes a builder run
//    queued after `usage_exhausted` (O-41, O-43). It runs after the staging and escalation passes,
//    so an escalation that pass recovers is taken first, and after step 1, whose dispatch already
//    started what the plan found due, so it finds those runs active and starts nothing twice.
// The stall check and the clean-up candidates (steps 5 and 6) are the pass's own reports, in both
// modes. In dry run none of this runs: the result carries the cancel step's report of what it
// would do instead. Everything here runs inside the reconcile flow's one Windmill run (D-164).
import { createEscalations, type EscalationStep } from "../../src/core/escalations.ts";
import {
  createHoldReleases,
  type HoldReleaseStep,
} from "../../src/core/hold-release.ts";
import { createMerges, type MergeResult } from "../../src/core/merge.ts";
import {
  createStillNeeded,
  type StillNeededOpen,
} from "../../src/core/still-needed.ts";
import type { ReconcileReport } from "../../src/core/reconcile.ts";
import {
  createStaging,
  type StagingDeployWait,
  type StagingResult,
} from "../../src/core/staging.ts";
import { startBuilderRuns, type BuilderRunStart } from "./builder-runs.ts";
import {
  firstRunsAfterStaging,
  startReadyRuns,
  type ReadyRunStart,
} from "./ready-runs.ts";
import {
  runReconcileSteps,
  type AdvanceStep,
  type DispatchStep,
  type ReleaseStep,
} from "./reconcile-steps.ts";
import { optionCapturePass, type OptionCapturePassStep } from "./option-capture.ts";
import { triagePass, type TriagePassStep } from "./triage-runs.ts";
import { createPlanApprovals, type PlanApprovalStep } from "../../src/core/plans.ts";
import type { FlowDeps } from "./compose.ts";
import type { FollowUpStep } from "../../src/core/council.ts";
import type { CancelStep } from "../../src/core/cancel.ts";
import type { CloseRunStart } from "../../src/core/pr-close.ts";
import { closePass } from "./close-runs.ts";
import {
  councilPass,
  cancelPass,
  followUpPass,
  redoPass,
  type CouncilPassStep,
  type RedoPassStep,
} from "./council-runs.ts";

export interface LivePasses {
  /** Step 2: each release the plan found due, its move, and the released item's first run. */
  released: ReleaseStep[] | null;
  /** Step 3: each first run the plan admitted and what its start did, or admission's refusal. */
  dispatched: DispatchStep[] | null;
  /** Step 4: each advance the plan found due, its move, and QA's run on the head. */
  advanced: AdvanceStep[] | null;
  /**
   * The first runs the staging, escalation and hold release passes started for the items they
   * made ready (D-329); the redo pass's are in `redos`.
   */
  firstRuns: ReadyRunStart[] | null;
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
  /** The "is this still needed?" questions the merged-change pass opened (D-308 (3)). */
  stillNeeded: StillNeededOpen[] | null;
  /**
   * What the cancel pass did for each cancel and Council stop (D-308); in dry run, what it would
   * do, from the dry-run pass.
   */
  cancels: CancelStep[] | null;
  /** The close runs the close pass started for cancelled items' pull requests (D-318). */
  closes: CloseRunStart[] | null;
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
  report: Pick<
    ReconcileReport,
    "mode" | "stopped" | "cancels" | "releases" | "dispatches" | "advances"
  >,
): Promise<LivePasses> {
  const { stopped, cancels: wouldStop } = report;
  if (stopped !== null || report.mode !== "live") {
    return {
      released: null,
      dispatched: null,
      advanced: null,
      firstRuns: null,
      merged: null,
      verified: null,
      stagingWaits: null,
      escalations: null,
      followUps: null,
      councilRuns: null,
      redos: null,
      stillNeeded: null,
      // In dry run, what the cancel step would do (D-308); nothing under the kill switch.
      cancels: stopped === null ? wouldStop : null,
      closes: null,
      plans: null,
      triage: null,
      holdReleases: null,
      optionCaptures: null,
      builderRuns: null,
      problems: [],
    };
  }
  const steps = await runReconcileSteps(deps, report);
  const merged = await createMerges(deps).mergeReady();
  const stillNeeded = await createStillNeeded(deps).mergedChangePass();
  const staging = createStaging({ ...deps, checker: deps.stagingChecker });
  const verified = await staging.verifyReady();
  const { waits, problem } = await staging.deployWaits(verified);
  const firstRuns = await firstRunsAfterStaging(deps, verified);
  const escalations = await createEscalations(deps).resolveAll();
  firstRuns.push(
    ...(await startReadyRuns(
      deps,
      escalations.filter((e) => e.step === "returned").map((e) => e.nodeId),
    )),
  );
  const followUps = await followUpPass(deps);
  const councilRuns = await councilPass(deps);
  const redos = await redoPass(deps);
  const cancels = await cancelPass(deps);
  const closes = await closePass(deps);
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
  firstRuns.push(
    ...(await startReadyRuns(
      deps,
      holdReleases.filter((h) => h.step === "released").map((h) => h.nodeId),
    )),
  );
  const optionCaptures = await optionCapturePass(deps);
  const builderRuns = await startBuilderRuns(deps);
  return {
    released: steps.releases,
    dispatched: steps.dispatches,
    advanced: steps.advances,
    firstRuns,
    merged,
    verified,
    stagingWaits: waits,
    escalations,
    followUps,
    councilRuns,
    redos,
    stillNeeded,
    cancels,
    closes,
    plans,
    triage,
    holdReleases,
    optionCaptures,
    builderRuns,
    problems: problem ? [problem] : [],
  };
}
