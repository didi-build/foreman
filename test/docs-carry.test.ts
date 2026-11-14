// Seam: unit, on the memory store with the real machine-2 contracts and guards and the fake GitHub.
// The builder's docs note carried over a newer head that only brings the base branch in (D-388,
// O-136, src/core/docs-carry.ts, through src/core/merge.ts): a PR whose branch a person updated
// from main merges on QA's pass with the Developer's note carried to the new head, and every other
// case (a PR file touched, history that does not contain the earlier head, a compare list that
// may be cut, the PR's own paths changed, paths not recorded, a compare that fails) carries
// nothing and merges nothing, as before. Fake data only.
import { describe, expect, it } from "vitest";

import { carriedDocsNoteKey, earlierDocsNote } from "../src/core/docs-carry.ts";
import type { GitHub } from "../src/core/github.ts";
import { createRunReports } from "../src/core/run-reports.ts";
import { NEW, PR, setupMerge } from "./merge-fixture.ts";
import { HEAD, REPO } from "./reconcile-fixture.ts";

/** The base branch's newest commit, which the update brought in. */
const MAIN = "a".repeat(40);
const PATHS = ["README.md"];

/**
 * The item's PR as the rehearsal had it: the Developer pushed HEAD and wrote its docs note there,
 * then a person updated the branch from main, so the PR's head is NEW, a merge of HEAD and MAIN,
 * with CI, the preview check and QA's pass on it and no docs note.
 */
async function updatedFromMain(
  options: {
    headPaths?: string[];
    earlierPaths?: string[] | null;
    dryRun?: boolean;
  } = {},
) {
  const t = await setupMerge({ paths: PATHS, dryRun: options.dryRun ?? false });
  await t.evidence(
    t.node.id,
    "ci_run",
    {
      conclusion: "success",
      pr: PR,
      ...(options.earlierPaths === null
        ? {}
        : { changedPaths: options.earlierPaths ?? PATHS }),
    },
    { commitSha: HEAD },
  );
  const noteId = await t.evidence(
    t.node.id,
    "docs_note",
    { impact: "none", note: "README only" },
    { commitSha: HEAD },
  );
  t.github.pushHead(REPO, PR, NEW);
  t.github.putCommit(REPO, NEW, [HEAD, MAIN]);
  t.github.setComparedPaths(REPO, HEAD, NEW, [".github/workflows/ci.yml", "docs/x.md"]);
  const qa = await t.passedOn(NEW, options.headPaths ?? PATHS, { docsNote: false });
  const notesOn = async (sha: string) =>
    (await t.store.listEvidence({ nodeId: t.node.id, kind: "docs_note" })).filter(
      (e) => e.commitSha === sha,
    );
  return { ...t, qa, noteId, notesOn };
}

describe("a docs note carried over an update from main (unit: D-388, O-136)", () => {
  it("carries the Developer's note to the new head and merges it there", async () => {
    const t = await updatedFromMain();

    const result = await t.merges().mergeOnPass(t.node.id, t.trigger);

    expect(result).toMatchObject({
      outcome: "applied",
      failedGuards: [],
      docsNote: "carried",
    });
    expect(t.github.merges).toEqual([{ repo: REPO, number: PR, headSha: NEW }]);
    expect(await t.state()).toBe("verifying_on_staging");
    expect(await t.notesOn(NEW)).toMatchObject([
      {
        ref: carriedDocsNoteKey(REPO, PR, NEW),
        recordedBy: "runner",
        runId: null,
        payload: {
          impact: "none",
          note: "README only",
          carriedFrom: { evidenceId: t.noteId, commitSha: HEAD },
        },
      },
    ]);
  });

  it("shows the carried note on QA's pass report", async () => {
    const t = await updatedFromMain();
    const move = await createRunReports(t.deps).requestReportedMove(t.qa.id);
    expect(move).toMatchObject({
      requested: true,
      outcome: "applied",
      toState: "verifying_on_staging",
      docsNote: "carried",
    });
  });

  it("writes the carried note once: dry run records it, and the next pass finds it", async () => {
    const t = await updatedFromMain({ dryRun: true });
    const first = await t.merges().mergeOnPass(t.node.id, t.trigger);
    expect(first).toMatchObject({ outcome: "planned", docsNote: "carried" });
    const second = await t.merges().mergeOnPass(t.node.id, t.trigger);
    // The note is on the head now, so the guard passes and nothing is carried again.
    expect(second.docsNote).toBeUndefined();
    expect(await t.notesOn(NEW)).toHaveLength(1);
    expect(t.github.merges).toEqual([]);
  });

  const refusals: [
    string,
    Parameters<typeof updatedFromMain>[0],
    (t: Awaited<ReturnType<typeof updatedFromMain>>) => void,
    string,
  ][] = [
    [
      "the update changed one of the PR's own files",
      {},
      (t) => t.github.setComparedPaths(REPO, HEAD, NEW, ["docs/x.md", "README.md"]),
      "pr_files_touched",
    ],
    [
      "the new head does not contain the earlier head",
      {},
      (t) => t.github.putCommit(REPO, NEW, [MAIN]),
      "not_ancestor",
    ],
    [
      "GitHub's compare list reached its cap and may be cut",
      {},
      (t) => t.github.setComparedPaths(REPO, HEAD, NEW, ["docs/x.md"], false),
      "compare_cut",
    ],
    [
      "the PR changes another path at the new head",
      { headPaths: ["README.md", "src/new.ts"] },
      () => {},
      "pr_paths_changed",
    ],
    [
      "the earlier head's CI recorded no paths",
      { earlierPaths: null },
      () => {},
      "no_paths_recorded",
    ],
  ];

  it.each(refusals)(
    "carries nothing and merges nothing when %s",
    async (_name, options, arrange, why) => {
      const t = await updatedFromMain(options);
      arrange(t);

      const result = await t.merges().mergeOnPass(t.node.id, t.trigger);

      expect(result).toMatchObject({ outcome: "rejected", docsNote: why });
      expect(result.failedGuards).toContain("docs_updated_or_none");
      expect(await t.notesOn(NEW)).toEqual([]);
      expect(t.github.merges).toEqual([]);
      expect(await t.state()).toBe("in_qa_review");
    },
  );

  it("carries nothing when GitHub's compare fails, and the merge still answers", async () => {
    const t = await updatedFromMain();
    const failing: GitHub = {
      ...t.github,
      listComparedPaths: async () => {
        throw new Error("comparing the commits failed with 500");
      },
    };
    const result = await t.merges(t.store, failing).mergeOnPass(t.node.id, t.trigger);
    expect(result).toMatchObject({ outcome: "rejected", docsNote: "compare_failed" });
    expect(await t.notesOn(NEW)).toEqual([]);
  });

  it("reads nothing from GitHub when no docs note names an earlier head of the PR", async () => {
    const t = await setupMerge({ paths: PATHS });
    await t.passedOn(HEAD, PATHS, { docsNote: false });
    const reads = t.github.reads;

    const result = await t.merges().mergeOnPass(t.node.id, t.trigger);

    expect(result).toMatchObject({ outcome: "rejected", reason: "guard_failed" });
    expect(result.failedGuards).toContain("docs_updated_or_none");
    expect(result.docsNote).toBeUndefined();
    expect(t.github.reads).toBe(reads);
  });

  it("takes only a note naming an earlier head of the same PR", async () => {
    const t = await updatedFromMain();
    // A newer note names a commit whose only CI is for PR 8, so it is not a head of this PR.
    const otherHead = "c".repeat(40);
    await t.evidence(
      t.node.id,
      "docs_note",
      { impact: "updated", note: "for PR 8" },
      { commitSha: otherHead },
    );
    await t.evidence(
      t.node.id,
      "ci_run",
      { conclusion: "success", pr: 8, changedPaths: PATHS },
      { commitSha: otherHead },
    );
    const target = { nodeId: t.node.id, repo: REPO, pr: PR, headSha: NEW };
    expect((await earlierDocsNote(t.store, target))?.id).toBe(t.noteId);
    expect((await earlierDocsNote(t.store, { ...target, pr: 8 }))?.commitSha).toBe(
      otherHead,
    );
  });
});
