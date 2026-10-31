// Guards on starting work: blockers, gates, readiness and the plan (ADR 0105).
import type { GuardCheck, GuardContext } from "../contracts.ts";
import type { CurrentDecision } from "../store.ts";
import { latest, result } from "./evidence.ts";

/** The state a node reaches when its work is finished. */
const DONE = "done";

async function blockers(ctx: GuardContext) {
  const edges = await ctx.store.listEdges({ toNode: ctx.node.id, type: "blocks" });
  const nodes = [];
  for (const edge of edges) {
    const blocker = await ctx.store.getNode(edge.fromNode);
    nodes.push({ id: edge.fromNode, node: blocker });
  }
  return nodes;
}

/** Every `blocks` edge into the node comes from a node in Done. */
export async function blockersDone(ctx: GuardContext): Promise<GuardCheck> {
  const open = (await blockers(ctx)).filter((b) => b.node?.state !== DONE);
  if (open.length > 0) {
    return result(
      "blockers_done",
      false,
      [],
      `open blockers: ${open.map((b) => b.id).join(", ")}`,
    );
  }
  return result("blockers_done", true, [], "no open blockers");
}

/**
 * A design item's own spec is merged (it carries `merge_commit` evidence); for any other item,
 * each design item blocking it has a `merge_commit` record.
 */
export async function designSpecMerged(ctx: GuardContext): Promise<GuardCheck> {
  const designNodes =
    ctx.node.track === "design"
      ? [ctx.node.id]
      : (await blockers(ctx))
          .filter((b) => b.node?.track === "design")
          .map((b) => b.id);
  const ids: string[] = [];
  const missing: string[] = [];
  for (const nodeId of designNodes) {
    const merge = latest(
      await ctx.store.listEvidence({ nodeId, kind: "merge_commit" }),
    );
    if (merge?.commitSha) ids.push(merge.id);
    else missing.push(nodeId);
  }
  if (missing.length > 0) {
    return result(
      "design_spec_merged",
      false,
      ids,
      `no merge on main for design item(s): ${missing.join(", ")}`,
    );
  }
  return result(
    "design_spec_merged",
    true,
    ids,
    designNodes.length === 0 ? "no design blockers" : "design spec merged on main",
  );
}

/** No open gate request on the node. */
export async function noPendingGate(ctx: GuardContext): Promise<GuardCheck> {
  const open = (await ctx.store.listOpenGateRequests(ctx.node.projectId)).filter(
    (g) => g.nodeId === ctx.node.id,
  );
  if (open.length > 0) {
    return result(
      "no_pending_gate",
      false,
      [],
      `open gate request(s): ${open.map((g) => g.topicKey).join(", ")}`,
    );
  }
  return result("no_pending_gate", true, [], "no open gate request");
}

/**
 * The node is agent-ready and not on hold, and not stale: a decision it relied on was reversed,
 * and no work starts on that basis until the Council decides what to redo (M3.5, O-45).
 */
export async function agentReadyNotOnHold(ctx: GuardContext): Promise<GuardCheck> {
  if (ctx.node.hold) return result("agent_ready_not_on_hold", false, [], "on hold");
  if (ctx.node.stale) {
    return result(
      "agent_ready_not_on_hold",
      false,
      [],
      "stale: a decision it relied on was reversed",
    );
  }
  if (!ctx.node.agentReady) {
    return result("agent_ready_not_on_hold", false, [], "not marked agent-ready");
  }
  return result("agent_ready_not_on_hold", true, [], "agent-ready and not on hold");
}

const scopeKind = (decision: CurrentDecision): unknown =>
  typeof decision.scope === "object" &&
  decision.scope !== null &&
  !Array.isArray(decision.scope)
    ? decision.scope.kind
    : undefined;

/**
 * The approved plan and the product direction are linked to the node: an active
 * `product_direction` decision, and an active `council_decision` whose scope kind is
 * `plan_accepted`.
 */
export async function planAttached(ctx: GuardContext): Promise<GuardCheck> {
  const active = (await ctx.store.listDecisionsForNode(ctx.node.id)).filter(
    (d) => d.status === "active",
  );
  const direction = latest(active.filter((d) => d.kind === "product_direction"));
  const plan = latest(
    active.filter(
      (d) => d.kind === "council_decision" && scopeKind(d) === "plan_accepted",
    ),
  );
  const missing = [!plan && "accepted plan", !direction && "product direction"].filter(
    Boolean,
  );
  if (missing.length > 0) {
    return result("plan_attached", false, [], `not linked: ${missing.join(" and ")}`);
  }
  return result("plan_attached", true, [], "plan and product direction linked");
}
