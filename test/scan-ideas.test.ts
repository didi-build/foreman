// Seam: unit, plain logic over the memory store with the real contracts and guards, a fixed clock
// and ids (D-162). The Scanner's stage 1 files its findings as ideas and records the scan
// (src/core/scan-ideas.ts, D-300, O-92): the idea fields, the cap of 5, the dedupe against open
// ideas and items, the switches and the failure record. And how its ideas change over time
// (D-301, O-93): a parked or rejected idea absorbing its finding until it is reopened, a new
// finding in the same file folded into the oldest open idea, and the clean up of ideas no longer
// found (Submitted withdrawn through the guarded runner-only move, further along recorded and
// asked about once per commit, and a withdrawal cancelling the idea's open plan-approval request,
// D-316 (4)), never on a failed scan, under a switch or for a check that did not
// run. Synthetic data only.
import { describe, expect, it } from "vitest";

import {
  createScanIdeas,
  readScanFailure,
  readScanSummary,
  SCAN_IDEA_CAP,
  SCANNER_SOURCE,
} from "../src/core/scan-ideas.ts";
import {
  SCAN_CHECKS,
  scanDedupeKey,
  type RepoScan,
  type ScanFinding,
} from "../src/core/scan.ts";
import type { Node, Store } from "../src/core/store.ts";
import { scannerGoneTopic } from "../src/core/scan-ideas.ts";
import { createLibrary } from "../src/core/library.ts";
import { planApprovalTopic } from "../src/core/plans.ts";
import { createReconcileFixture } from "./reconcile-fixture.ts";

const SHA = "c".repeat(40);

const link = (n: number): ScanFinding => ({
  check: "doc_link_missing",
  path: "docs/a.md",
  line: n,
  target: `docs/missing-${n}.md`,
});

function scanOf(
  findings: ScanFinding[],
  extra: Partial<RepoScan["counts"]> = {},
): RepoScan {
  const counts = Object.fromEntries(
    SCAN_CHECKS.map((c) => [c, 0]),
  ) as RepoScan["counts"];
  for (const f of findings) counts[f.check] += 1;
  return { commitSha: SHA, counts: { ...counts, ...extra }, findings, notRun: [] };
}

async function fixture() {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  const scans = createScanIdeas(f.deps);
  const ideas = async (): Promise<Node[]> =>
    (await f.store.listNodes({ projectId: f.projectId })).filter(
      (n) =>
        n.type === "idea" && (n.body as { source?: string }).source === SCANNER_SOURCE,
    );
  return { ...f, scans, ideas };
}

describe("filing a scan's findings as ideas (unit: D-300, O-92)", () => {
  it("creates one idea per finding in Machine 1's entry state, with the scanner's fields, and records the scan", async () => {
    const f = await fixture();
    const finding: ScanFinding = {
      check: "gallery_spec_missing",
      path: "components/button/button.gallery.ts",
      line: 3,
      target: "design/gallery/buton/spec.md",
    };
    const filed = await f.scans.file(f.projectId, scanOf([finding]));
    expect(filed.step).toBe("filed");
    const [idea] = await f.ideas();
    expect(idea).toMatchObject({
      type: "idea",
      state: "submitted",
      ownerRole: "runner",
      track: null,
      hold: false,
      title: "Gallery entry names a missing spec: components/button/button.gallery.ts",
      body: {
        source: "scanner",
        class: "bug",
        check: "gallery_spec_missing",
        evidence: [{ path: "components/button/button.gallery.ts", line: 3 }],
        confidence: 1,
        dedupeKey: scanDedupeKey(finding),
        foundBy: { scanner: "fixed-checks", commitSha: SHA },
      },
    });
    expect((idea?.body as { description: string }).description).toContain(
      "design/gallery/buton/spec.md",
    );
    // No transition and no gate request: the idea is inserted, never moved.
    expect(await f.store.listTransitions(idea?.id ?? "")).toEqual([]);
    expect(await f.store.listOpenGateRequests(f.projectId)).toEqual([]);
    const record = await f.store.getLatestScan(f.projectId);
    expect(record).toMatchObject({
      projectId: f.projectId,
      commitSha: SHA,
      outcome: "scanned",
      recordedBy: "runner:scanner",
    });
    expect(readScanSummary(record?.summary ?? null)).toEqual({
      counts: { ...scanOf([finding]).counts },
      findings: 1,
      newIdeas: [
        {
          nodeId: idea?.id,
          title: idea?.title,
          check: "gallery_spec_missing",
          class: "bug",
        },
      ],
      merged: 0,
      folded: [],
      overCap: 0,
      cap: SCAN_IDEA_CAP,
      gone: [],
      listed: [finding],
      notRun: [],
    });
  });

  it("files at most 5 new ideas per scan; the rest, listed or only counted, are over the cap", async () => {
    const f = await fixture();
    // Each in its own file, so none folds into another (D-304).
    const findings = Array.from({ length: 8 }, (_, i) => ({
      ...link(i + 1),
      path: `docs/a${i + 1}.md`,
    }));
    const filed = await f.scans.file(
      f.projectId,
      scanOf(findings, { doc_link_missing: 12 }),
    );
    expect(filed).toMatchObject({
      step: "filed",
      summary: { findings: 12, merged: 0, overCap: 7, cap: 5 },
    });
    expect(
      (await f.ideas()).map((n) => (n.body as { dedupeKey: string }).dedupeKey),
    ).toEqual(findings.slice(0, 5).map(scanDedupeKey));
  });

  it("folds a finding into an idea the same scan filed earlier for the same check and file (D-304)", async () => {
    const f = await fixture();
    const filed = await f.scans.file(f.projectId, scanOf([link(1), link(2), link(3)]));
    expect(filed).toMatchObject({
      step: "filed",
      summary: { findings: 3, merged: 0, overCap: 0 },
    });
    expect(filed.step === "filed" && filed.summary.newIdeas).toHaveLength(1);
    expect(filed.step === "filed" && filed.summary.folded).toHaveLength(2);
    const [idea] = await f.ideas();
    const updates = await f.store.listEvidence({
      nodeId: idea!.id,
      kind: "scan_scope_update",
    });
    expect(updates.map((e) => (e.payload as { line: number }).line)).toEqual([2, 3]);
    // The next day all three merge into that one idea, as if they had appeared one per day.
    f.advanceMinutes(24 * 60);
    const next = await f.scans.file(f.projectId, scanOf([link(1), link(2), link(3)]));
    expect(next).toMatchObject({ summary: { merged: 3, newIdeas: [], folded: [] } });
  });

  it("merges a finding already on an open scanner idea: nothing new is recorded for it, and the cap counts only new ideas", async () => {
    const f = await fixture();
    const first = [link(1), { ...link(2), path: "docs/a2.md" }];
    await f.scans.file(f.projectId, scanOf(first));
    f.advanceMinutes(24 * 60);
    // New findings in other files: none folds into the open ideas (D-301 (2)).
    const next = await f.scans.file(
      f.projectId,
      scanOf([
        ...first,
        ...Array.from({ length: 6 }, (_, i) => ({
          ...link(i + 3),
          path: `docs/b${i}.md`,
        })),
      ]),
    );
    expect(next).toMatchObject({ summary: { findings: 8, merged: 2, overCap: 1 } });
    expect(next.step === "filed" && next.summary.newIdeas).toHaveLength(5);
    expect(await f.ideas()).toHaveLength(7);
    // A finding's line moving does not make it new.
    const moved = await f.scans.file(f.projectId, scanOf([{ ...link(1), line: 40 }]));
    expect(moved).toMatchObject({ summary: { merged: 1, newIdeas: [] } });
  });

  it("merges a finding whose idea was handed off while one of its items is unfinished, and files it again once all are done", async () => {
    const f = await fixture();
    await f.scans.file(f.projectId, scanOf([link(1)]));
    const [idea] = await f.ideas();
    // The idea went through Triage: handed off (terminal for Machine 1), split into an item.
    await f.store.changeNodeState(idea?.id ?? "", 0, {
      state: "handed_off",
      substate: null,
      ownerRole: "runner",
      blockedReason: null,
      stateSince: f.clock.now(),
      updatedAt: f.clock.now(),
    });
    const item = await f.node("ready_for_dev");
    await f.store.insertEdge({
      id: f.deps.ids.next(),
      fromNode: idea?.id ?? "",
      toNode: item.id,
      type: "split_into",
      createdAt: f.clock.now(),
    });
    expect(await f.scans.file(f.projectId, scanOf([link(1)]))).toMatchObject({
      summary: { merged: 1, newIdeas: [] },
    });
    await f.store.changeNodeState(item.id, 0, {
      state: "done",
      substate: null,
      ownerRole: "runner",
      blockedReason: null,
      stateSince: f.clock.now(),
      updatedAt: f.clock.now(),
    });
    expect(await f.scans.file(f.projectId, scanOf([link(1)]))).toMatchObject({
      summary: { merged: 0, newIdeas: [{ check: "doc_link_missing" }] },
    });
  });

  it("does not merge with an idea that is not the scanner's", async () => {
    const f = await fixture();
    await f.node("submitted", {
      type: "idea",
      track: null,
      body: { source: "run_finding", dedupeKey: scanDedupeKey(link(1)) },
    });
    expect(await f.scans.file(f.projectId, scanOf([link(1)]))).toMatchObject({
      summary: { merged: 0 },
    });
  });

  it.each([
    ["the kill switch", "kill_switch", true],
    ["dry run", "dry_run", true],
  ] as const)("writes nothing under %s", async (_label, key, value) => {
    const f = await fixture();
    await f.setting(key, value);
    expect(await f.scans.file(f.projectId, scanOf([link(1)]))).toEqual({
      step: "refused",
      reason: key,
    });
    expect(await f.scans.recordFailure(f.projectId, "job")).toEqual({
      step: "refused",
      reason: key,
    });
    expect(await f.ideas()).toEqual([]);
    expect(await f.store.getLatestScan(f.projectId)).toBeNull();
  });

  it("treats a missing dry_run setting as dry run", async () => {
    const f = await fixture();
    const store: Store = {
      ...f.store,
      transaction: (work) =>
        f.store.transaction((tx) =>
          work({
            ...tx,
            getSetting: async (key) => (key === "dry_run" ? null : tx.getSetting(key)),
          }),
        ),
    };
    const scans = createScanIdeas({ ...f.deps, store });
    expect(await scans.file(f.projectId, scanOf([link(1)]))).toEqual({
      step: "refused",
      reason: "dry_run",
    });
  });

  it("refuses a project that does not exist", async () => {
    const f = await fixture();
    expect(
      await f.scans.file("50000000-0000-4000-8000-999999999999", scanOf([link(1)])),
    ).toEqual({ step: "refused", reason: "no_project" });
  });

  it("records a failed scan by its step's fixed name only", async () => {
    const f = await fixture();
    expect(await f.scans.recordFailure(f.projectId, "result", SHA)).toEqual({
      step: "recorded",
    });
    const record = await f.store.getLatestScan(f.projectId);
    expect(record).toMatchObject({
      outcome: "failed",
      commitSha: SHA,
      summary: { failure: "result" },
    });
    expect(readScanFailure(record?.summary ?? null)).toBe("result");
    expect(readScanFailure({ failure: "rm -rf" })).toBeNull();
  });

  it("reads back only a summary of the shape it writes", () => {
    expect(readScanSummary(null)).toBeNull();
    expect(readScanSummary({ counts: {}, findings: 0 })).toBeNull();
    expect(
      readScanSummary({
        counts: Object.fromEntries(SCAN_CHECKS.map((c) => [c, 0])),
        findings: 0,
        newIdeas: [{ nodeId: "x", title: "t", check: "nope", class: "drift" }],
        merged: 0,
        overCap: 0,
        cap: 5,
      }),
    ).toBeNull();
  });
});

const OTHER_SHA = "d".repeat(40);

/** A scan at `sha` of these findings, nothing else counted. */
const scanAt = (
  sha: string,
  findings: ScanFinding[],
  extra: Partial<RepoScan> = {},
) => ({
  ...scanOf(findings),
  commitSha: sha,
  ...extra,
});

async function d301() {
  const f = await fixture();
  /** Moves a node in the store, as a later move of Machine 1 or Didi would. */
  const move = async (node: Node, state: string) => {
    const now = (await f.store.getNode(node.id)) as Node;
    await f.store.changeNodeState(node.id, now.version, {
      state,
      substate: null,
      ownerRole: now.ownerRole,
      blockedReason: null,
      stateSince: f.clock.now(),
      updatedAt: f.clock.now(),
    });
  };
  const day = () => f.advanceMinutes(24 * 60);
  const keyed = async (key: string) =>
    (await f.ideas()).find((n) => (n.body as { dedupeKey: string }).dedupeKey === key);
  return { ...f, move, day, keyed };
}

describe("how scanner ideas change over time (unit: D-301, O-93)", () => {
  it.each(["parked", "rejected"])(
    "merges a finding whose idea is %s, filing nothing, until the idea is reopened",
    async (state) => {
      const f = await d301();
      await f.scans.file(f.projectId, scanOf([link(1)]));
      const [idea] = await f.ideas();
      await f.move(idea as Node, state);
      f.day();
      expect(await f.scans.file(f.projectId, scanOf([link(1)]))).toMatchObject({
        summary: { merged: 1, newIdeas: [], folded: [], gone: [] },
      });
      expect(await f.ideas()).toHaveLength(1);
      // Reopened: back in Submitted, it is open, so the finding still merges into it.
      await f.move(idea as Node, "submitted");
      f.day();
      expect(await f.scans.file(f.projectId, scanOf([link(1)]))).toMatchObject({
        summary: { merged: 1, newIdeas: [] },
      });
      // Out of Parked or Rejected and finished (handed off, no work left): filed again.
      await f.move(idea as Node, "handed_off");
      f.day();
      expect(await f.scans.file(f.projectId, scanOf([link(1)]))).toMatchObject({
        summary: { merged: 0, newIdeas: [{ check: "doc_link_missing" }] },
      });
      expect(await f.ideas()).toHaveLength(2);
    },
  );

  it("folds a new finding with the same check and file into the open idea as a scope update, and merges it later", async () => {
    const f = await d301();
    await f.scans.file(f.projectId, scanOf([link(1)]));
    const [idea] = await f.ideas();
    f.day();
    const folded = await f.scans.file(
      f.projectId,
      scanAt(OTHER_SHA, [link(1), link(2)]),
    );
    expect(folded).toMatchObject({
      step: "filed",
      summary: {
        merged: 1,
        newIdeas: [],
        overCap: 0,
        folded: [
          {
            nodeId: idea?.id,
            title: idea?.title,
            check: "doc_link_missing",
            dedupeKey: scanDedupeKey(link(2)),
          },
        ],
      },
    });
    const updates = await f.store.listEvidence({
      nodeId: idea?.id ?? "",
      kind: "scan_scope_update",
    });
    const scanId = (await f.store.getLatestScan(f.projectId))?.id;
    expect(updates).toMatchObject([
      {
        commitSha: OTHER_SHA,
        ref: `scan:${scanId}`,
        recordedBy: "runner:scanner",
        payload: { ...link(2), dedupeKey: scanDedupeKey(link(2)) },
      },
    ]);
    // A later scan treats the folded key as the idea's: merged, nothing new.
    f.day();
    expect(
      await f.scans.file(f.projectId, scanAt(OTHER_SHA, [link(1), link(2)])),
    ).toMatchObject({ summary: { merged: 2, newIdeas: [], folded: [] } });
    // A new finding of another check, or in another file, is not folded in.
    f.day();
    const elsewhere = await f.scans.file(
      f.projectId,
      scanAt(OTHER_SHA, [link(1), link(2), { ...link(3), path: "docs/z.md" }]),
    );
    expect(elsewhere).toMatchObject({
      summary: { folded: [], newIdeas: [{ check: "doc_link_missing" }] },
    });
    expect(await f.ideas()).toHaveLength(2);
  });

  it("does not count folded findings toward the cap", async () => {
    const f = await d301();
    await f.scans.file(f.projectId, scanOf([link(1)]));
    f.day();
    const others = Array.from({ length: 6 }, (_, i) => ({
      ...link(20 + i),
      path: `docs/o${i}.md`,
    }));
    const next = await f.scans.file(
      f.projectId,
      scanOf([link(1), link(2), link(3), ...others]),
    );
    expect(next).toMatchObject({
      summary: { findings: 9, merged: 1, overCap: 1 },
    });
    expect(next.step === "filed" && next.summary.folded).toHaveLength(2);
    expect(next.step === "filed" && next.summary.newIdeas).toHaveLength(5);
  });

  it("folds into the oldest of several open ideas of the same check and file, and never into a closed one", async () => {
    const f = await d301();
    const scannerIdea = (n: number, minutesAgo: number) =>
      f.node("submitted", {
        type: "idea",
        track: null,
        ownerRole: "runner",
        title: `Idea ${n}`,
        body: {
          source: "scanner",
          check: "doc_link_missing",
          evidence: [{ path: "docs/a.md", line: n }],
          dedupeKey: scanDedupeKey(link(n)),
        },
        createdAt: new Date(f.clock.now().getTime() - minutesAgo * 60_000),
      });
    // Made in this order, so the ids do not follow the age: the oldest is parked, then the
    // second oldest is the one a new finding goes to.
    await scannerIdea(1, 10);
    const oldest = await scannerIdea(2, 30);
    const secondOldest = await scannerIdea(3, 20);
    await f.move(oldest, "parked");
    f.day();
    const next = await f.scans.file(
      f.projectId,
      scanOf([link(1), link(2), link(3), link(4)]),
    );
    expect(next).toMatchObject({
      summary: {
        merged: 3,
        folded: [{ nodeId: secondOldest.id, title: "Idea 3" }],
        newIdeas: [],
      },
    });
  });

  it("withdraws an idea still in Submitted that the scan no longer finds, through the guarded runner-only move", async () => {
    const f = await d301();
    await f.scans.file(
      f.projectId,
      scanOf([link(1), { ...link(2), path: "docs/b.md" }]),
    );
    const gone = await f.keyed(scanDedupeKey(link(1)));
    f.day();
    const next = await f.scans.file(
      f.projectId,
      scanAt(OTHER_SHA, [{ ...link(2), path: "docs/b.md" }]),
    );
    const record = await f.store.getLatestScan(f.projectId);
    expect(next).toMatchObject({
      step: "filed",
      summary: {
        merged: 1,
        gone: [
          {
            nodeId: gone?.id,
            title: gone?.title,
            state: "submitted",
            action: "withdraw",
          },
        ],
      },
      withdrawals: [{ nodeId: gone?.id, outcome: "applied" }],
    });
    expect((await f.store.getNode(gone?.id ?? ""))?.state).toBe("rejected");
    const [reason] = await f.store.listEvidence({
      nodeId: gone?.id ?? "",
      kind: "scan_not_found",
    });
    expect(reason).toMatchObject({
      commitSha: OTHER_SHA,
      payload: { note: `No longer found by the scanner at commit ${OTHER_SHA}.` },
    });
    const [moved] = await f.store.listTransitions(gone?.id ?? "");
    expect(moved).toMatchObject({
      fromState: "submitted",
      toState: "rejected",
      triggerKind: "event",
      triggerRef: `scan:${record?.id}`,
      actorKind: "runner",
      actorId: "runner:scanner",
      mode: "applied",
      reason: `No longer found by the scanner at commit ${OTHER_SHA}.`,
      evidenceIds: [reason?.id],
    });
    expect(moved?.guardResult).toMatchObject([
      { name: "scanner_finding_gone", pass: true },
    ]);
    // Withdrawn, it is rejected: its finding coming back merges into it, so Didi can reopen it.
    f.day();
    expect(
      await f.scans.file(
        f.projectId,
        scanOf([link(1), { ...link(2), path: "docs/b.md" }]),
      ),
    ).toMatchObject({ summary: { merged: 2, newIdeas: [], gone: [] } });
  });

  it("records an idea further along as no longer found and asks the Council once per commit, never moving it or its work items", async () => {
    const f = await d301();
    await f.scans.file(f.projectId, scanOf([link(1)]));
    const [idea] = await f.ideas();
    await f.move(idea as Node, "handed_off");
    const item = await f.node("in_development");
    await f.store.insertEdge({
      id: f.deps.ids.next(),
      fromNode: idea?.id ?? "",
      toNode: item.id,
      type: "split_into",
      createdAt: f.clock.now(),
    });
    f.day();
    const next = await f.scans.file(f.projectId, scanAt(OTHER_SHA, []));
    expect(next).toMatchObject({
      summary: {
        gone: [{ nodeId: idea?.id, state: "handed_off", action: "asked_council" }],
      },
      withdrawals: [],
    });
    const topic = scannerGoneTopic(idea?.id ?? "");
    const question = await f.store.findOpenGateRequest(f.projectId, topic);
    expect(question).toMatchObject({
      nodeId: idea?.id,
      kind: "council_question",
      owner: "council",
      blocking: false,
      payload: { commitSha: OTHER_SHA },
    });
    const notFound = () =>
      f.store.listEvidence({ nodeId: idea?.id ?? "", kind: "scan_not_found" });
    expect(await notFound()).toHaveLength(1);
    // Nothing moved: not the idea, not its item.
    expect((await f.store.getNode(idea?.id ?? ""))?.state).toBe("handed_off");
    expect(await f.store.listTransitions(idea?.id ?? "")).toEqual([]);
    expect(await f.store.getNode(item.id)).toEqual(item);
    // The same commit again: nothing new recorded, no second question.
    f.day();
    await f.scans.file(f.projectId, scanAt(OTHER_SHA, []));
    expect(await notFound()).toHaveLength(1);
    expect(await f.store.listGateRequests(f.projectId, topic)).toHaveLength(1);
    // A new commit while the question is open: recorded, and still one question.
    f.day();
    await f.scans.file(f.projectId, scanAt("e".repeat(40), []));
    expect(await notFound()).toHaveLength(2);
    expect(await f.store.listGateRequests(f.projectId, topic)).toHaveLength(1);
    // Once that question is answered, the next new commit asks again.
    await f.store.closeGateRequest(question?.id ?? "", {
      status: "cancelled",
      at: f.clock.now(),
    });
    f.day();
    await f.scans.file(f.projectId, scanAt("f".repeat(40), []));
    expect(await notFound()).toHaveLength(3);
    expect(await f.store.findOpenGateRequest(f.projectId, topic)).toMatchObject({
      payload: { commitSha: "f".repeat(40) },
    });
  });

  it("cancels the open plan-approval request of an idea it withdraws, in the withdrawal's transaction (D-316 (4))", async () => {
    const f = await d301();
    await f.scans.file(
      f.projectId,
      scanOf([link(1), { ...link(2), path: "docs/b.md" }]),
    );
    const gone = (await f.keyed(scanDedupeKey(link(1)))) as Node;
    const kept = (await f.keyed(
      scanDedupeKey({ ...link(2), path: "docs/b.md" }),
    )) as Node;
    const library = createLibrary(f.deps);
    const request = (ideaId: string) =>
      library.openGateRequest({
        projectId: f.projectId,
        nodeId: ideaId,
        topicKey: planApprovalTopic(ideaId),
        kind: "scope",
        owner: "didi",
        blocking: true,
        payload: { question: "Approve this plan?", plan: "A plan." },
      });
    // An earlier request Didi answered, then the open one for the latest plan.
    const answered = await request(gone.id);
    await library.answerGateRequest(answered.id, {
      nodeId: gone.id,
      kind: "answer",
      scope: { topicKey: answered.topicKey, outcome: "changes_requested" },
      textVerbatim: "Smaller.",
      byActor: "didi",
    });
    const open = await request(gone.id);
    // Another idea's open request is not touched.
    const other = await request(kept.id);
    f.day();
    const next = await f.scans.file(
      f.projectId,
      scanAt(OTHER_SHA, [{ ...link(2), path: "docs/b.md" }]),
    );
    expect(next).toMatchObject({
      withdrawals: [{ nodeId: gone.id, outcome: "applied" }],
    });
    expect((await f.store.getNode(gone.id))?.state).toBe("rejected");
    expect(await f.store.getGateRequest(open.id)).toMatchObject({
      status: "cancelled",
      decisionId: null,
    });
    expect((await f.store.getGateRequest(answered.id))?.status).toBe("answered");
    expect((await f.store.getGateRequest(other.id))?.status).toBe("open");
    // Nothing new is opened on the topic.
    expect(
      await f.store.listGateRequests(f.projectId, planApprovalTopic(gone.id)),
    ).toHaveLength(2);
  });

  it("leaves the plan-approval request open when the withdrawal is not applied", async () => {
    const f = await d301();
    await f.scans.file(f.projectId, scanOf([link(1)]));
    const [idea] = (await f.ideas()) as Node[];
    const open = await createLibrary(f.deps).openGateRequest({
      projectId: f.projectId,
      nodeId: idea!.id,
      topicKey: planApprovalTopic(idea!.id),
      kind: "scope",
      owner: "didi",
      blocking: true,
      payload: { question: "Approve this plan?", plan: "A plan." },
    });
    f.day();
    // The kill switch turns on between the filing and the move: the move refuses, and the
    // request it would have cancelled stays open.
    const real = f.store.transaction.bind(f.store);
    let calls = 0;
    f.store.transaction = (async (work: Parameters<typeof real>[0]) => {
      const out = await real(work);
      calls += 1;
      if (calls === 1) await f.setting("kill_switch", true);
      return out;
    }) as typeof f.store.transaction;
    const next = await f.scans.file(f.projectId, scanAt(OTHER_SHA, []));
    expect(next).toMatchObject({
      withdrawals: [{ nodeId: idea!.id, outcome: "refused" }],
    });
    expect((await f.store.getNode(idea!.id))?.state).toBe("submitted");
    expect((await f.store.getGateRequest(open.id))?.status).toBe("open");
  });

  it("cleans up nothing on a failed scan, or under the kill switch or dry run", async () => {
    const f = await d301();
    await f.scans.file(f.projectId, scanOf([link(1)]));
    const [idea] = await f.ideas();
    f.day();
    await f.scans.recordFailure(f.projectId, "job", OTHER_SHA);
    for (const [key, value] of [
      ["kill_switch", true],
      ["dry_run", true],
    ] as const) {
      await f.setting(key, value);
      expect(await f.scans.file(f.projectId, scanAt(OTHER_SHA, []))).toEqual({
        step: "refused",
        reason: key,
      });
      await f.setting(key, false);
    }
    expect((await f.store.getNode(idea?.id ?? ""))?.state).toBe("submitted");
    expect(
      await f.store.listEvidence({ nodeId: idea?.id ?? "", kind: "scan_not_found" }),
    ).toEqual([]);
    expect(await f.store.listOpenGateRequests(f.projectId)).toEqual([]);
  });

  it.each<[string, Partial<RepoScan>]>([
    [
      "its check did not run over its file",
      { notRun: [{ check: "doc_link_missing", path: "docs/a.md" }] },
    ],
    [
      "its check did not run at all",
      { notRun: [{ check: "doc_link_missing", path: null }] },
    ],
    [
      "its check found more than the Job listed",
      { counts: { ...scanOf([]).counts, doc_link_missing: 1 } },
    ],
  ])("does not take an idea as gone when %s", async (_label, extra) => {
    const f = await d301();
    await f.scans.file(f.projectId, scanOf([link(1)]));
    const [idea] = await f.ideas();
    f.day();
    expect(await f.scans.file(f.projectId, scanAt(OTHER_SHA, [], extra))).toMatchObject(
      {
        summary: { gone: [] },
        withdrawals: [],
      },
    );
    expect((await f.store.getNode(idea?.id ?? ""))?.state).toBe("submitted");
  });

  it("lets only the runner's own step take the move to Rejected, never any other request", async () => {
    const f = await d301();
    await f.scans.file(
      f.projectId,
      scanOf([link(1), { ...link(2), path: "docs/b.md" }]),
    );
    const idea = await f.keyed(scanDedupeKey(link(1)));
    f.day();
    const library = createLibrary(f.deps);
    const request = {
      nodeId: idea?.id ?? "",
      toState: "rejected",
      trigger: { kind: "event" as const, ref: "scan:x" },
      actor: { kind: "operator" as const, id: "didi" },
    };
    expect(await library.requestTransition(request)).toMatchObject({
      outcome: "rejected",
      reason: "runner_only_move",
    });
    // With the flag but no scan since the idea was filed, the guard refuses.
    expect(
      await library.requestTransition({ ...request, runnerOnly: true }),
    ).toMatchObject({
      outcome: "rejected",
      reason: "guard_failed",
      guardReport: [{ name: "scanner_finding_gone", pass: false }],
    });
    expect((await f.store.getNode(idea?.id ?? ""))?.state).toBe("submitted");
  });

  it("takes an idea of the registry check as gone only when the registry check ran", async () => {
    const f = await d301();
    const unregistered: ScanFinding = {
      check: "gallery_entry_unregistered",
      path: "components/a/a.gallery.ts",
      line: null,
      target: null,
    };
    await f.scans.file(f.projectId, scanOf([unregistered]));
    const [idea] = await f.ideas();
    f.day();
    // The registry is missing: the check did not run, so the idea is not gone.
    await f.scans.file(
      f.projectId,
      scanAt(OTHER_SHA, [], {
        notRun: [{ check: "gallery_entry_unregistered", path: null }],
      }),
    );
    expect((await f.store.getNode(idea?.id ?? ""))?.state).toBe("submitted");
    f.day();
    await f.scans.file(f.projectId, scanAt(OTHER_SHA, []));
    expect((await f.store.getNode(idea?.id ?? ""))?.state).toBe("rejected");
  });
});
