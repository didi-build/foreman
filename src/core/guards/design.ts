// Guards on the design track: options, Didi's visual approval, the spec and its components
// (ADR 0105). Topic keys follow one convention: the visual-approval request for a node is
// `visual-approval:<node id>`.
import type { GuardCheck, GuardContext } from "../contracts.ts";
import type { CurrentDecision, Json } from "../store.ts";
import {
  NO_HEAD,
  headCommit,
  latest,
  onCommit,
  readSpecPaths,
  readTestReport,
  result,
} from "./evidence.ts";

export const visualApprovalTopic = (nodeId: string): string =>
  `visual-approval:${nodeId}`;

const scopeOf = (decision: CurrentDecision): { [key: string]: Json } =>
  typeof decision.scope === "object" &&
  decision.scope !== null &&
  !Array.isArray(decision.scope)
    ? decision.scope
    : {};

/** The latest active decision on the node's visual-approval request, if any. */
async function visualAnswer(ctx: GuardContext): Promise<CurrentDecision | undefined> {
  const topic = visualApprovalTopic(ctx.node.id);
  return latest(
    (await ctx.store.listDecisionsForNode(ctx.node.id)).filter(
      (d) => d.status === "active" && scopeOf(d).topicKey === topic,
    ),
  );
}

/** The Designer's options are attached (screenshots) and one visual-approval request is open. */
export async function optionsAttached(ctx: GuardContext): Promise<GuardCheck> {
  const shots = await ctx.store.listEvidence({
    nodeId: ctx.node.id,
    kind: "screenshot",
  });
  if (shots.length === 0)
    return result("options_attached", false, [], "no options attached");
  const ids = shots.map((s) => s.id);
  const request = await ctx.store.findOpenGateRequest(
    ctx.node.projectId,
    visualApprovalTopic(ctx.node.id),
  );
  if (request?.kind !== "visual_approval") {
    return result("options_attached", false, ids, "no open visual-approval request");
  }
  return result(
    "options_attached",
    true,
    ids,
    `${shots.length} option(s), request open`,
  );
}

/** Didi's latest answer on the visual-approval request is an approval, verbatim. */
export async function approvalRecorded(ctx: GuardContext): Promise<GuardCheck> {
  const answer = await visualAnswer(ctx);
  if (!answer) return result("approval_recorded", false, [], "no answer recorded");
  if (answer.kind !== "approval" || answer.byActor !== "didi") {
    return result(
      "approval_recorded",
      false,
      [],
      "the latest answer is not Didi's approval",
    );
  }
  if (answer.textVerbatim.trim() === "") {
    return result("approval_recorded", false, [], "the approval has no verbatim text");
  }
  return result(
    "approval_recorded",
    true,
    [],
    `approved by Didi (decision ${answer.id})`,
  );
}

/** Didi's latest answer asks for changes or rejects, verbatim. */
export async function changesRequestedRecorded(ctx: GuardContext): Promise<GuardCheck> {
  const name = "changes_requested_recorded";
  const answer = await visualAnswer(ctx);
  if (!answer) return result(name, false, [], "no answer recorded");
  const outcome = scopeOf(answer).outcome;
  if (
    answer.byActor !== "didi" ||
    answer.kind !== "answer" ||
    (outcome !== "changes_requested" && outcome !== "rejected")
  ) {
    return result(name, false, [], "the latest answer does not ask for changes");
  }
  if (answer.textVerbatim.trim() === "")
    return result(name, false, [], "the answer has no verbatim text");
  return result(
    name,
    true,
    [],
    `Didi ${outcome === "rejected" ? "rejected" : "asked for changes"}`,
  );
}

/**
 * Every commit touching the spec paths was made by the Designer's identity, which is the
 * `designer_identity` setting.
 */
export async function specEditedByDesignerOnly(ctx: GuardContext): Promise<GuardCheck> {
  const name = "spec_edited_by_designer_only";
  const spec = latest(
    await ctx.store.listEvidence({ nodeId: ctx.node.id, kind: "spec_paths" }),
  );
  if (!spec) return result(name, false, [], "no spec paths recorded");
  const payload = readSpecPaths(spec.payload);
  if (!payload) return result(name, false, [spec.id], "malformed spec_paths payload");
  const designer = (await ctx.store.getSetting("designer_identity"))?.value;
  if (typeof designer !== "string" || designer === "") {
    return result(name, false, [spec.id], "designer_identity setting is not set");
  }
  const others = payload.commits.filter((c) => c.author !== designer);
  if (others.length > 0) {
    return result(
      name,
      false,
      [spec.id],
      `spec edited by others: ${others.map((c) => `${c.sha} by ${c.author}`).join(", ")}`,
    );
  }
  return result(name, true, [spec.id], "only the Designer edited the spec");
}

/**
 * No new feature or user flow beyond the plan. Deterministic part: the Designer's spec declares
 * none, or the Council approved the extra scope after the spec was recorded (an active
 * `council_decision` whose scope kind is `scope_approved`). Anything else is a judgment call for
 * the Council (D-177). Never asks a model.
 */
export async function scopeMatchesPlan(ctx: GuardContext): Promise<GuardCheck> {
  const name = "scope_matches_plan";
  const spec = latest(
    await ctx.store.listEvidence({ nodeId: ctx.node.id, kind: "spec_paths" }),
  );
  if (!spec) return result(name, false, [], "no spec paths recorded");
  const payload = readSpecPaths(spec.payload);
  if (!payload) return result(name, false, [spec.id], "malformed spec_paths payload");
  const extra = [...payload.newFeatures, ...payload.newFlows];
  if (extra.length === 0)
    return result(name, true, [spec.id], "no new feature or flow");
  const approved = (await ctx.store.listDecisionsForNode(ctx.node.id)).some(
    (d) =>
      d.status === "active" &&
      d.kind === "council_decision" &&
      scopeOf(d).kind === "scope_approved" &&
      d.recordedAt.getTime() >= spec.recordedAt.getTime(),
  );
  if (approved)
    return result(name, true, [spec.id], "the Council approved the extra scope");
  return result(
    name,
    false,
    [spec.id],
    `needs Council: beyond the plan: ${extra.join(", ")}`,
  );
}

/** Every component the spec lists exists in the gallery build on the head commit. */
export async function specComponentsExist(ctx: GuardContext): Promise<GuardCheck> {
  const name = "spec_components_exist";
  const spec = latest(
    await ctx.store.listEvidence({ nodeId: ctx.node.id, kind: "spec_paths" }),
  );
  if (!spec) return result(name, false, [], "no spec paths recorded");
  const payload = readSpecPaths(spec.payload);
  if (!payload) return result(name, false, [spec.id], "malformed spec_paths payload");
  const head = await headCommit(ctx);
  if (!head) return result(name, false, [spec.id], NO_HEAD);
  const report = latest(
    (await onCommit(ctx, "test_report", head.sha)).filter((e) => {
      const parsed = readTestReport(e.payload);
      return parsed?.suite === "gallery";
    }),
  );
  if (!report)
    return result(
      name,
      false,
      [spec.id],
      `no gallery build report on head ${head.sha}`,
    );
  const gallery = readTestReport(report.payload)?.galleryComponents;
  if (!gallery)
    return result(
      name,
      false,
      [spec.id, report.id],
      "the gallery report lists no components",
    );
  const missing = payload.components.filter((c) => !gallery.includes(c));
  if (missing.length > 0) {
    return result(
      name,
      false,
      [spec.id, report.id],
      `missing components: ${missing.join(", ")}`,
    );
  }
  return result(
    name,
    true,
    [spec.id, report.id],
    "every spec component is in the gallery",
  );
}
