// Bugs a run noticed outside its item become ideas for the Council (D-244, O-65). A Developer,
// Designer or QA run may end with `outOfScopeFindings` in its result (./out-of-scope-findings.ts):
// at most 3, each a title and what was seen. When the run-end flow has a successful result from
// one of those roles, it calls `submit` before it records the run's end, and the runner, not the
// agent, creates one idea per finding in Machine 1's entry state (Submitted, owned by the runner,
// ./ideas.ts), the same front door the Scanner will use (D-150). The Council sizes each idea; the
// current item is not changed, not moved and not escalated.
//
// Each idea is marked with who found it: `body.foundBy` holds the role, the item and the run.
// `body.description` is the finding's detail and the title is the finding's title, both the
// agent's own words as the image checked them and with credential values removed; the runner
// checks the list again here and creates nothing from a list of the wrong shape. Once per run:
// the transaction locks only the run's item, then looks for ideas already marked with the run, so
// a repeated or concurrent run end finds them and writes nothing. The new ideas are inserted,
// never locked. Under the kill switch or in dry run it writes nothing. Plain logic over an
// injected store, clock and id source (D-162).
//
// The Scanner's stage 1 files its findings through the same two steps (./scan-ideas.ts, D-300,
// O-92): `switchesHolding` and `insertIdea`.
import type { Clock, IdSource } from "./library.ts";
import { IDEA_ENTRY } from "./ideas.ts";
import {
  OUT_OF_SCOPE_FINDINGS,
  readOutOfScopeFindings,
} from "./out-of-scope-findings.ts";
import type { AgentRole, Json, Node, Store, StoreOps } from "./store.ts";
import { PUSHING_ROLES } from "./task-input.ts";

/** The roles whose runs may report bugs outside their item (D-244). */
export const FINDING_ROLES: readonly AgentRole[] = [...PUSHING_ROLES, "qa"];

/** The mark on an idea created from a run's finding. */
export const FINDING_SOURCE = "run_finding";

export interface FindingIdeasOptions {
  store: Store;
  clock: Clock;
  ids: IdSource;
}

/** What `submit` did. Only counts, never an id (a database id). */
export type FindingIdeas =
  /** The result lists no findings, or the run's role does not report them. */
  | { step: "none" }
  | { step: "created" | "already_created"; ideas: number }
  | {
      step: "refused";
      reason: "no_run" | "no_node" | "bad_findings" | "kill_switch" | "dry_run";
    };

const field = (value: Json | undefined, key: string): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value[key]
    : undefined;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether the node is an idea created from a finding of this run. */
const fromRun = (node: Node, runId: string): boolean =>
  node.type === "idea" &&
  field(node.body, "source") === FINDING_SOURCE &&
  field(field(node.body, "foundBy"), "runId") === runId;

/** Which switch holds the runner from creating ideas now, read in the writing transaction. */
export async function switchesHolding(
  tx: Pick<StoreOps, "getSetting">,
): Promise<"kill_switch" | "dry_run" | null> {
  if ((await tx.getSetting("kill_switch"))?.value === true) return "kill_switch";
  if ((await tx.getSetting("dry_run"))?.value !== false) return "dry_run";
  return null;
}

/**
 * Inserts one idea in Machine 1's entry state (Submitted, owned by the runner, ./ideas.ts), as
 * the runner creates it from a finding. Inserted, never locked; no transition is written.
 */
export async function insertIdea(
  tx: Pick<StoreOps, "insertNode">,
  idea: { id: string; projectId: string; title: string; body: Json; at: Date },
): Promise<void> {
  await tx.insertNode({
    id: idea.id,
    projectId: idea.projectId,
    type: "idea",
    track: null,
    state: IDEA_ENTRY.state,
    substate: null,
    ownerRole: IDEA_ENTRY.ownerRole,
    title: idea.title,
    body: idea.body,
    hold: false,
    agentReady: false,
    stale: false,
    blockedReason: null,
    stateSince: idea.at,
    linearIssueId: null,
    linearStatusSynced: null,
    version: 0,
    createdAt: idea.at,
    updatedAt: idea.at,
  });
}

export function createFindingIdeas({ store, clock, ids }: FindingIdeasOptions) {
  return {
    /**
     * Creates one idea per finding in the run's result `structured`, once per run. Call it only
     * for a run that ended as its instructions say (the run-end flow passes a successful result).
     */
    async submit(runId: string, structured: unknown): Promise<FindingIdeas> {
      const listed = isObject(structured)
        ? structured[OUT_OF_SCOPE_FINDINGS]
        : undefined;
      if (listed === undefined) return { step: "none" };
      const run = await store.getRun(runId);
      if (!run) return { step: "refused", reason: "no_run" };
      if (!FINDING_ROLES.includes(run.bot as AgentRole)) return { step: "none" };
      const read = readOutOfScopeFindings(listed);
      if ("problem" in read) return { step: "refused", reason: "bad_findings" };
      if (read.findings.length === 0) return { step: "none" };
      const nodeId = run.nodeId;
      if (!nodeId) return { step: "refused", reason: "no_node" };
      return store.transaction(async (tx): Promise<FindingIdeas> => {
        const switches = await switchesHolding(tx);
        if (switches) return { step: "refused", reason: switches };
        // The only node locked: the ideas are inserted, never locked.
        const item = await tx.getNodeForUpdate(nodeId);
        if (!item) return { step: "refused", reason: "no_node" };
        const earlier = (await tx.listNodes({ projectId: item.projectId })).filter(
          (n) => fromRun(n, run.id),
        );
        if (earlier.length > 0)
          return { step: "already_created", ideas: earlier.length };
        const at = clock.now();
        for (const finding of read.findings) {
          await insertIdea(tx, {
            id: ids.next(),
            projectId: item.projectId,
            title: finding.title,
            body: {
              source: FINDING_SOURCE,
              description: finding.detail,
              foundBy: { role: run.bot, nodeId: item.id, runId: run.id },
            },
            at,
          });
        }
        return { step: "created", ideas: read.findings.length };
      });
    },
  };
}

export type FindingIdeasModule = ReturnType<typeof createFindingIdeas>;
