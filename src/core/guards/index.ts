// The guard registry: exactly the 24 guards of ADR 0105, by name. Contracts name guards; the
// library looks them up here. See docs/guards.md for the evidence each one reads.
import type { GuardRegistry } from "../contracts.ts";
import {
  agentReadyNotOnHold,
  blockersDone,
  designSpecMerged,
  noPendingGate,
  planAttached,
} from "./dispatch.ts";
import {
  approvalRecorded,
  changesRequestedRecorded,
  optionsAttached,
  scopeMatchesPlan,
  specComponentsExist,
  specEditedByDesignerOnly,
} from "./design.ts";
import {
  councilDecisionRecorded,
  didiAnswerRecorded,
  didiQuestionOpen,
  escalationTriggerMet,
} from "./escalation.ts";
import {
  ciGreenOnHead,
  docsUpdatedOrNone,
  notThirdFailedRound,
  privilegedPathsApproved,
  prodEnvProtected,
  qaFailedWithFindings,
  qaVerdictIndependentOnHead,
} from "./review.ts";
import { stagingCheckFailed, stagingCheckOnMergeCommit } from "./staging.ts";

export const GUARDS: GuardRegistry = {
  blockers_done: blockersDone,
  design_spec_merged: designSpecMerged,
  no_pending_gate: noPendingGate,
  agent_ready_not_on_hold: agentReadyNotOnHold,
  ci_green_on_head: ciGreenOnHead,
  docs_updated_or_none: docsUpdatedOrNone,
  qa_verdict_independent_on_head: qaVerdictIndependentOnHead,
  privileged_paths_approved: privilegedPathsApproved,
  prod_env_protected: prodEnvProtected,
  qa_failed_with_findings: qaFailedWithFindings,
  not_third_failed_round: notThirdFailedRound,
  staging_check_on_merge_commit: stagingCheckOnMergeCommit,
  staging_check_failed: stagingCheckFailed,
  plan_attached: planAttached,
  options_attached: optionsAttached,
  approval_recorded: approvalRecorded,
  changes_requested_recorded: changesRequestedRecorded,
  spec_edited_by_designer_only: specEditedByDesignerOnly,
  scope_matches_plan: scopeMatchesPlan,
  spec_components_exist: specComponentsExist,
  escalation_trigger_met: escalationTriggerMet,
  council_decision_recorded: councilDecisionRecorded,
  didi_question_open: didiQuestionOpen,
  didi_answer_recorded: didiAnswerRecorded,
};

export const GUARD_NAMES: readonly string[] = Object.keys(GUARDS);
