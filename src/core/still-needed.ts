// When the Council is asked whether a work item is still needed (D-308 (3), O-97). The question
// is the Council's `still_needed` kind (./council.ts), a sibling of the scanner question on an
// idea (`scanner_gone`, D-301) with the same answer: `stop`, `keep` or `cannot_decide`. It is a
// `council_question` gate request owned by the Council on `still-needed:<item id>`, not blocking,
// whose payload says why it was asked. Three triggers open it here; the fourth, the Scanner no
// longer finding an idea's finding, stays the scan's (./scan-ideas.ts).
//
// - A merged change (`afterMerge`, `mergedChangePass`): once an item's merge is recorded, each
//   open work item of the same project that touches the same design feature folder is asked
//   about. A feature folder is `design/<area>/<feature>/`, the repository's unit of a feature and
//   its spec (AGENTS.md, docs/component-gallery.md). An item's folders are read only from what
//   the store records for it: the paths its latest `ci_run` says its pull request changes, the
//   paths of its latest `spec_paths`, and its body's `pathsInScope`. Code paths are left out on
//   purpose: two items often share a file such as a package manifest or a router without being
//   the same feature, and asking about each would be noise. Only a merge recorded after the open
//   item was created counts, and each pair is asked about once.
// - The item's own run reports the work already done (`afterAlreadyDone`): a Developer or Designer
//   run that stopped with `{"stopped": "already_done", ...}`. Its report escalated the item to the
//   Council as a stop for a decision does (./run-reports.ts); the escalation question waits while
//   this question is open (./council.ts), so a `keep` or `cannot_decide` lets the escalation go
//   on as before.
// - Didi asks (`askByDidi`), from the called flow `f/foreman/cancel_item` with `askCouncil`.
//
// One question per item at a time: none opens while one is open on the item, while a request for
// Didi to confirm a cancel is open on the item or its idea, while the scanner question is open on
// its idea, or while a cancel or a Council stop stands on the item or its idea. A finished item,
// or one already merged (it has no cancel move), is never asked about. Under the kill switch
// nothing opens; in dry run nothing opens and the result says what would.
import {
  CANCEL_GUARD,
  CANCEL_REQUEST_PREFIX,
  CANCELLED_STATE,
  didiCancelReason,
  ideaOf,
  ITEM_END_STATES,
  readCancelOfItem,
  stillNeededTopic,
} from "./cancel.ts";
import type { StillNeededReason } from "./council-input.ts";
import type { Contracts, GuardRegistry } from "./contracts.ts";
import { latest, readCiRun, readSpecPaths } from "./guards/evidence.ts";
import { createLibrary, type Clock, type IdSource } from "./library.ts";
import { scannerGoneTopic } from "./scan-ideas.ts";
import type { Json, Node, Store, StoreOps } from "./store.ts";
import { readItemBody } from "./task-input.ts";

export type { StillNeededReason };

const FOLDER = /^design\/([^/]+)\/([^/]+)\//;

/** The feature folder `design/<area>/<feature>/` a path lies in, or null. */
export function featureFolderOf(path: string): string | null {
  const match = FOLDER.exec(path.trim().replace(/^\.?\//, ""));
  return match ? `design/${match[1]}/${match[2]}/` : null;
}

/** The feature folders of some paths, sorted and unique. */
export function featureFoldersOf(paths: readonly string[]): string[] {
  return [
    ...new Set(paths.map(featureFolderOf).filter((f): f is string => f !== null)),
  ].sort();
}

/** The paths the store records for an item: its PR's changed paths, its spec paths, its scope. */
export async function recordedPaths(
  store: Pick<StoreOps, "listEvidence">,
  node: Pick<Node, "id" | "body">,
): Promise<string[]> {
  const ci = latest(await store.listEvidence({ nodeId: node.id, kind: "ci_run" }));
  const spec = latest(
    await store.listEvidence({ nodeId: node.id, kind: "spec_paths" }),
  );
  let scope: string[] = [];
  try {
    scope = readItemBody(node.body).pathsInScope;
  } catch {
    // A body of the wrong shape records no paths.
  }
  return [
    ...((ci && readCiRun(ci.payload)?.changedPaths) ?? []),
    ...((spec && readSpecPaths(spec.payload)?.paths) ?? []),
    ...scope,
  ];
}

/** What opening a question did, or would do. */
export type StillNeededOpen =
  | { nodeId: string; opened: true; gateRequestId: string; reason: StillNeededReason }
  | {
      nodeId: string;
      opened: false;
      reason: StillNeededReason;
      why:
        | "kill_switch"
        | "dry_run"
        | "no_node"
        | "not_a_work_item"
        | "finished_or_merged"
        | "question_open"
        | "cancel_stands"
        | "already_asked";
    };

export interface StillNeededDeps {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
}

const isObject = (value: Json | undefined): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: Json | undefined, key: string): Json | undefined =>
  isObject(value) ? value[key] : undefined;

export function createStillNeeded(deps: StillNeededDeps) {
  const { store, contracts } = deps;
  const library = createLibrary(deps);

  const hasCancelMove = (node: Node): boolean =>
    contracts.transitions.some(
      (m) =>
        m.from === node.state &&
        m.to === CANCELLED_STATE &&
        m.guards.includes(CANCEL_GUARD) &&
        (!m.tracks || (node.track !== null && m.tracks.includes(node.track))),
    );

  /**
   * Opens the question on one item, once, with the payload saying why. `seen` says whether an
   * earlier request on the topic already asked for the same reason (the same merge or run).
   */
  async function open(
    nodeId: string,
    reason: StillNeededReason,
    payload: { [key: string]: Json },
    seen: (earlier: { [key: string]: Json }) => boolean,
  ): Promise<StillNeededOpen> {
    const no = (
      why: Extract<StillNeededOpen, { opened: false }>["why"],
    ): StillNeededOpen => ({
      nodeId,
      opened: false,
      reason,
      why,
    });
    if ((await store.getSetting("kill_switch"))?.value === true)
      return no("kill_switch");
    const node = await store.getNode(nodeId);
    if (!node) return no("no_node");
    if (node.type !== "work_item") return no("not_a_work_item");
    if (ITEM_END_STATES.includes(node.state) || !hasCancelMove(node))
      return no("finished_or_merged");
    const topic = stillNeededTopic(node.id);
    const earlier = await store.listGateRequests(node.projectId, topic);
    if (earlier.some((g) => seen(isObject(g.payload) ? g.payload : {})))
      return no("already_asked");
    const idea = await ideaOf(store, node);
    const open = await store.listOpenGateRequests(node.projectId);
    const busy = open.some(
      (g) =>
        g.topicKey === topic ||
        (g.nodeId === node.id && g.topicKey.startsWith(CANCEL_REQUEST_PREFIX)) ||
        (idea !== null &&
          (g.topicKey === scannerGoneTopic(idea.id) ||
            (g.nodeId === idea.id && g.topicKey.startsWith(CANCEL_REQUEST_PREFIX)))),
    );
    if (busy) return no("question_open");
    if (await readCancelOfItem(store, node, idea)) return no("cancel_stands");
    // A missing setting means dry run, as in the library.
    if ((await store.getSetting("dry_run"))?.value !== false) return no("dry_run");
    const gate = await store.transaction(async (tx) => {
      await tx.getNodeForUpdate(node.id);
      if (await tx.findOpenGateRequest(node.projectId, topic)) return null;
      return library.openGateRequestWith(tx, {
        projectId: node.projectId,
        nodeId: node.id,
        topicKey: topic,
        kind: "council_question",
        owner: "council",
        blocking: false,
        payload: { reason, ...payload },
      });
    });
    return gate
      ? { nodeId, opened: true, gateRequestId: gate.id, reason }
      : no("question_open");
  }

  const stillNeeded = {
    /**
     * After an item's merge is recorded: asks about each open work item of the same project that
     * touches one of the same design feature folders and was created before the merge.
     */
    async afterMerge(mergedNodeId: string): Promise<StillNeededOpen[]> {
      const merged = await store.getNode(mergedNodeId);
      if (!merged || merged.type !== "work_item") return [];
      const mergeCommit = latest(
        await store.listEvidence({ nodeId: merged.id, kind: "merge_commit" }),
      );
      if (!mergeCommit) return [];
      const folders = featureFoldersOf(await recordedPaths(store, merged));
      if (folders.length === 0) return [];
      const steps: StillNeededOpen[] = [];
      for (const other of await store.listNodes({ projectId: merged.projectId })) {
        if (other.id === merged.id || other.type !== "work_item") continue;
        if (ITEM_END_STATES.includes(other.state)) continue;
        if (other.createdAt.getTime() >= mergeCommit.recordedAt.getTime()) continue;
        const shared = featureFoldersOf(await recordedPaths(store, other)).filter((f) =>
          folders.includes(f),
        );
        if (shared.length === 0) continue;
        steps.push(
          await open(
            other.id,
            "merged_change",
            {
              mergedNodeId: merged.id,
              mergeCommitSha: mergeCommit.commitSha,
              folders: shared,
            },
            (p) => p.reason === "merged_change" && p.mergedNodeId === merged.id,
          ),
        );
      }
      return steps;
    },

    /** `afterMerge` for every merged work item: the reconcile flow's safety net. */
    async mergedChangePass(): Promise<StillNeededOpen[]> {
      const steps: StillNeededOpen[] = [];
      for (const node of await store.listNodes({})) {
        if (node.type !== "work_item") continue;
        if (
          (await store.listEvidence({ nodeId: node.id, kind: "merge_commit" }))
            .length === 0
        )
          continue;
        steps.push(...(await stillNeeded.afterMerge(node.id)));
      }
      return steps.filter((s) => s.opened || s.why === "dry_run");
    },

    /**
     * After a builder's run stopped reporting the work already done: asks about its item, once
     * per run. The run's reason is quoted from its recorded report.
     */
    async afterAlreadyDone(runId: string): Promise<StillNeededOpen | null> {
      const run = await store.getRun(runId);
      if (!run?.nodeId) return null;
      const report = (
        await store.listEvidence({ nodeId: run.nodeId, kind: "agent_report" })
      ).find((e) => e.runId === run.id && field(e.payload, "alreadyDone") === true);
      if (!report) return null;
      const words = field(report.payload, "reason");
      return open(
        run.nodeId,
        "already_done",
        { runId: run.id, words: typeof words === "string" ? words : null },
        (p) => p.reason === "already_done" && p.runId === run.id,
      );
    },

    /** Didi asks the Council whether an item is still needed, with Didi's words as data. */
    async askByDidi(nodeId: string, words: string): Promise<StillNeededOpen> {
      return open(
        nodeId,
        "didi_asked",
        { words: didiCancelReason(words) },
        () => false,
      );
    },
  };
  return stillNeeded;
}

export type StillNeeded = ReturnType<typeof createStillNeeded>;
