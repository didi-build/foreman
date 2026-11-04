// Seam: unit, plain logic over the memory store with the real contracts, a fixed clock and ids
// (D-162). The Scanner's stage 1 files its findings as ideas and records the scan
// (src/core/scan-ideas.ts, D-300, O-92): the idea fields, the cap of 5, the dedupe against open
// ideas and items, the switches and the failure record. Synthetic data only.
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
  return { commitSha: SHA, counts: { ...counts, ...extra }, findings };
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
      overCap: 0,
      cap: SCAN_IDEA_CAP,
    });
  });

  it("files at most 5 new ideas per scan; the rest, listed or only counted, are over the cap", async () => {
    const f = await fixture();
    const findings = Array.from({ length: 8 }, (_, i) => link(i + 1));
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

  it("merges a finding already on an open scanner idea: nothing new is recorded for it, and the cap counts only new ideas", async () => {
    const f = await fixture();
    await f.scans.file(f.projectId, scanOf([link(1), link(2)]));
    f.advanceMinutes(24 * 60);
    const next = await f.scans.file(
      f.projectId,
      scanOf([link(1), link(2), ...Array.from({ length: 6 }, (_, i) => link(i + 3))]),
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
