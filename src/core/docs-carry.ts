// The builder's docs note carried over a newer head that only brings the base branch in (D-388,
// O-136). `docs_updated_or_none` counts a docs note for the head commit only. When a person updates
// a pull request's branch from main (GitHub's "Update branch"), the PR gets a new head with no
// builder run, so the Developer's note no longer counts and the item stays In QA review for good:
// the rehearsal's first pull request stopped there. The runner's merge (./merge.ts) therefore
// carries the note over itself, from facts it reads, when the newer head changed nothing the PR
// itself changes:
//
// 1. A docs note names an earlier head A of the same PR: a commit with a recorded `ci_run` for
//    this PR. The newest such note is the one carried.
// 2. The PR's changed paths are the same at A and at the head B, as the `ci_run`s recorded them
//    (GitHub's own list of the PR's files at each head).
// 3. GitHub's compare of A...B says A is an ancestor of B, lists every file that changed from A to
//    B (fewer than its cap of 300), and none of them is one of the PR's changed paths.
//
// Together these mean B holds the PR's files exactly as A did, and every other file as the base
// branch has it: the newer commits only brought the base in. Anything else, or a fact that cannot
// be read, carries nothing and the guard stays failed, as before. The carried note is a
// `docs_note` on B written by the runner, with the earlier note's impact and words and
// `carriedFrom` naming that note and A, its `ref` naming the PR and B. It is written when B has
// no carried note yet; once it has, the guard passes and the merge carries nothing again.
import type { ComparedPaths, GitHubCommitReader } from "./github.ts";
import { latest, readCiRun, readDocsNote } from "./guards/evidence.ts";
import type { Clock, IdSource } from "./library.ts";
import type { Evidence, Json, Store } from "./store.ts";

/** The guard whose failure a carried note may settle. */
export const DOCS_GUARD = "docs_updated_or_none";

/** What the carry-over did, as the merge reports it: `carried`, or why nothing was carried. */
export type DocsCarryOutcome =
  | "carried"
  | "no_earlier_note"
  | "no_paths_recorded"
  | "pr_paths_changed"
  | "compare_failed"
  | "not_ancestor"
  | "compare_cut"
  | "pr_files_touched";

export interface DocsCarryDeps {
  store: Store;
  github: Pick<GitHubCommitReader, "listComparedPaths">;
  clock: Clock;
  ids: IdSource;
}

export interface DocsCarryTarget {
  nodeId: string;
  repo: string;
  pr: number;
  headSha: string;
}

/** The `ref` of the carried note: one per PR and head. */
export const carriedDocsNoteKey = (repo: string, pr: number, headSha: string): string =>
  `runner:docs_note_carried:${repo}#${pr}:${headSha}`;

/** The PR's changed paths a `ci_run` for this PR recorded on a commit, if any. */
async function recordedPaths(
  store: Store,
  nodeId: string,
  pr: number,
  commitSha: string,
): Promise<{ found: boolean; paths?: string[] }> {
  const runs = (await store.listEvidence({ nodeId, commitSha, kind: "ci_run" }))
    .map((e) => readCiRun(e.payload))
    .filter((ci) => ci?.pr === pr);
  const ci = latest(runs);
  if (!ci) return { found: false };
  return ci.changedPaths ? { found: true, paths: ci.changedPaths } : { found: true };
}

/**
 * The newest docs note naming an earlier head of the same PR (step 1), or null. Reads the store
 * only, so the merge can ask before it reads GitHub.
 */
export async function earlierDocsNote(
  store: Store,
  target: DocsCarryTarget,
): Promise<Evidence | null> {
  const notes = await store.listEvidence({ nodeId: target.nodeId, kind: "docs_note" });
  for (const note of [...notes].reverse()) {
    if (note.commitSha === null || note.commitSha === target.headSha) continue;
    if (!readDocsNote(note.payload)) continue;
    const ran = await recordedPaths(store, target.nodeId, target.pr, note.commitSha);
    if (ran.found) return note;
  }
  return null;
}

/** Carries the earlier head's docs note over to the head when steps 1 to 3 hold. */
export async function carryDocsNote(
  deps: DocsCarryDeps,
  target: DocsCarryTarget,
): Promise<DocsCarryOutcome> {
  const { store } = deps;
  const note = await earlierDocsNote(store, target);
  if (!note?.commitSha) return "no_earlier_note";
  const from = note.commitSha;
  const before = (await recordedPaths(store, target.nodeId, target.pr, from)).paths;
  const now = (await recordedPaths(store, target.nodeId, target.pr, target.headSha))
    .paths;
  if (!before || !now) return "no_paths_recorded";
  const prPaths = new Set(now);
  if (new Set(before).size !== prPaths.size || !before.every((p) => prPaths.has(p))) {
    return "pr_paths_changed";
  }

  let compared: ComparedPaths;
  try {
    compared = await deps.github.listComparedPaths(target.repo, from, target.headSha);
  } catch {
    return "compare_failed";
  }
  if (compared.relation !== "ahead") return "not_ancestor";
  if (!compared.complete) return "compare_cut";
  if (compared.paths.some((path) => prPaths.has(path))) return "pr_files_touched";

  // The note's ref names the PR and head. It is not an ingest key: the database allows those on
  // GitHub's own facts only (migration 0021), so the note is written as `merge_check` is, and
  // only when this head has none yet.
  const ref = carriedDocsNoteKey(target.repo, target.pr, target.headSha);
  const onHead = await store.listEvidence({
    nodeId: target.nodeId,
    commitSha: target.headSha,
    kind: "docs_note",
  });
  if (!onHead.some((e) => e.ref === ref)) {
    await store.insertEvidence({
      id: deps.ids.next(),
      nodeId: target.nodeId,
      runId: null,
      kind: "docs_note",
      ref,
      commitSha: target.headSha,
      payload: carriedPayload(note, from),
      recordedBy: "runner",
      recordedAt: deps.clock.now(),
      supersedesId: null,
    });
  }
  return "carried";
}

/** The earlier note's impact and words, with where they were carried from. */
function carriedPayload(note: Evidence, from: string): Json {
  const { payload } = note;
  const words =
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof payload.note === "string"
      ? payload.note
      : undefined;
  return {
    impact: readDocsNote(payload)?.impact ?? null,
    ...(words === undefined ? {} : { note: words }),
    carriedFrom: { evidenceId: note.id, commitSha: from },
  };
}
