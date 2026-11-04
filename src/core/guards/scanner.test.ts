// Seam: unit, the guard `scanner_finding_gone` (D-301, O-93) on the memory store. The library
// refusing its move to anyone but the scan's filing step is in test/scan-ideas.test.ts. The guard passes only for a scanner idea
// in Submitted whose project's latest scan that ran, after the idea was filed, certainly found none
// of its keys, its own and the folded ones. Synthetic data only.
import { describe, expect, it } from "vitest";

import { createMemoryStore } from "../memory-store.ts";
import { SCAN_CHECKS, scanDedupeKey, type ScanFinding } from "../scan.ts";
import type { Json, Node, ScanRecord } from "../store.ts";
import { scannerFindingGone } from "./scanner.ts";

const PROJECT = "70000000-0000-4000-8000-000000000001";
const IDEA = "70000000-0000-4000-8000-000000000002";
const SHA = "a".repeat(40);
const LATER = "b".repeat(40);
const T0 = Date.UTC(2026, 10, 1, 5, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

const FINDING: ScanFinding = {
  check: "doc_link_missing",
  path: "docs/a.md",
  line: 3,
  target: "docs/gone.md",
};
const FOLDED: ScanFinding = { ...FINDING, line: 9, target: "docs/also-gone.md" };

const counts = (n: Record<string, number> = {}): Record<string, number> => ({
  ...Object.fromEntries(SCAN_CHECKS.map((c) => [c, 0])),
  ...n,
});

/** A scan record as the filing step writes it. */
function summary(listed: ScanFinding[], extra: { [key: string]: Json } = {}): Json {
  return {
    counts: counts({ doc_link_missing: listed.length }),
    findings: listed.length,
    newIdeas: [],
    merged: 0,
    folded: [],
    overCap: 0,
    cap: 5,
    gone: [],
    listed: listed as unknown as Json,
    notRun: [],
    ...extra,
  };
}

async function fixture(idea: Partial<Node> = {}) {
  const store = createMemoryStore();
  await store.insertProject({
    id: PROJECT,
    slug: "p",
    name: "P",
    repo: "didi-build/p",
    linearProjectId: null,
    galleryPathOverride: null,
    privilegedPathsExtra: [],
    prodRequiresApproval: false,
    stagingUrl: null,
    createdAt: at(0),
  });
  const node: Node = {
    id: IDEA,
    projectId: PROJECT,
    type: "idea",
    track: null,
    state: "submitted",
    substate: null,
    ownerRole: "runner",
    title: "Broken link",
    body: {
      source: "scanner",
      check: FINDING.check,
      evidence: [{ path: FINDING.path, line: FINDING.line }],
      dedupeKey: scanDedupeKey(FINDING),
    },
    hold: false,
    agentReady: false,
    stale: false,
    blockedReason: null,
    stateSince: at(0),
    linearIssueId: null,
    linearStatusSynced: null,
    version: 0,
    createdAt: at(0),
    updatedAt: at(0),
    ...idea,
  };
  await store.insertNode(node);
  let n = 10;
  const id = () => `70000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const scan = (minutes: number, record: Partial<ScanRecord> = {}) =>
    store.insertScan({
      id: id(),
      projectId: PROJECT,
      commitSha: LATER,
      outcome: "scanned",
      summary: summary([]),
      recordedBy: "runner:scanner",
      recordedAt: at(minutes),
      ...record,
    });
  const fold = (f: ScanFinding) =>
    store.insertEvidence({
      id: id(),
      nodeId: IDEA,
      runId: null,
      kind: "scan_scope_update",
      ref: "scan:x",
      commitSha: SHA,
      payload: { ...f, dedupeKey: scanDedupeKey(f) },
      recordedBy: "runner:scanner",
      recordedAt: at(1),
      supersedesId: null,
    });
  const check = async () =>
    scannerFindingGone({ node: (await store.getNode(IDEA)) as Node, store });
  return { store, scan, fold, check, id };
}

describe("scanner_finding_gone (unit: guard on the memory store, D-301)", () => {
  it("passes when the latest scan that ran, after the idea was filed, found none of its keys, naming the reason recorded", async () => {
    const f = await fixture();
    await f.fold(FOLDED);
    await f.scan(60);
    const reason = f.id();
    await f.store.insertEvidence({
      id: reason,
      nodeId: IDEA,
      runId: null,
      kind: "scan_not_found",
      ref: "scan:x",
      commitSha: LATER,
      payload: { note: "No longer found." },
      recordedBy: "runner:scanner",
      recordedAt: at(60),
      supersedesId: null,
    });
    // A failed scan after it does not hide the latest one that ran.
    await f.scan(90, {
      outcome: "failed",
      commitSha: null,
      summary: { failure: "job" },
    });
    expect(await f.check()).toMatchObject({
      pass: true,
      evidenceIds: [reason],
      detail: `no longer found by the scanner at commit ${LATER}`,
    });
  });

  it.each<[string, Partial<Node>, RegExp]>([
    [
      "an idea not from the Scanner",
      { body: { source: "run_finding" } },
      /not an idea the Scanner/,
    ],
    ["a work item", { type: "work_item", track: "code" }, /not an idea the Scanner/],
    ["an idea past Submitted", { state: "council_planning" }, /not in Submitted/],
    ["an idea already rejected", { state: "rejected" }, /not in Submitted/],
    [
      "an idea whose own finding cannot be read",
      { body: { source: "scanner", dedupeKey: scanDedupeKey(FINDING) } },
      /cannot be read/,
    ],
  ])("fails for %s", async (_label, idea, detail) => {
    const f = await fixture(idea);
    await f.scan(60);
    expect(await f.check()).toMatchObject({
      pass: false,
      detail: expect.stringMatching(detail),
    });
  });

  it("fails with no scan, or only a failed one, or one recorded no later than the idea", async () => {
    const f = await fixture();
    expect((await f.check()).detail).toMatch(/no scan of the project has run/);
    await f.scan(60, {
      outcome: "failed",
      commitSha: null,
      summary: { failure: "job" },
    });
    expect((await f.check()).detail).toMatch(/no scan of the project has run/);
    await f.scan(0);
    expect((await f.check()).detail).toMatch(/since the idea was filed/);
  });

  it("fails on a record that does not list what it found, or cannot be read", async () => {
    const f = await fixture();
    const older = summary([]) as Record<string, Json>;
    delete older.listed;
    delete older.notRun;
    await f.scan(60, { summary: older });
    expect((await f.check()).detail).toMatch(/does not list what it found/);
    await f.scan(61, { summary: { findings: "many" } });
    expect((await f.check()).detail).toMatch(/does not list what it found/);
  });

  it.each<[string, Json]>([
    ["finds its own finding", summary([FINDING])],
    ["finds a finding folded into it", summary([FOLDED])],
    [
      "did not run the check over the idea's file",
      summary([], { notRun: [{ check: "doc_link_missing", path: "docs/a.md" }] }),
    ],
    [
      "did not run the check at all",
      summary([], { notRun: [{ check: "doc_link_missing", path: null }] }),
    ],
    [
      "found more of the check than it listed",
      summary([], { counts: counts({ doc_link_missing: 3 }) }),
    ],
  ])("fails when the latest scan %s", async (_label, record) => {
    const f = await fixture();
    await f.fold(FOLDED);
    await f.scan(60, { summary: record });
    expect(await f.check()).toMatchObject({
      pass: false,
      detail: expect.stringMatching(
        /found one of the idea's findings|did not run in full/,
      ),
    });
  });

  it("fails when a folded finding cannot be read, so the idea is never taken as gone", async () => {
    const f = await fixture();
    await f.store.insertEvidence({
      id: f.id(),
      nodeId: IDEA,
      runId: null,
      kind: "scan_scope_update",
      ref: "scan:x",
      commitSha: SHA,
      payload: { check: "doc_link_missing", path: "/etc/passwd", dedupeKey: "x" },
      recordedBy: "runner:scanner",
      recordedAt: at(1),
      supersedesId: null,
    });
    await f.scan(60);
    expect((await f.check()).detail).toMatch(/cannot be read/);
  });
});
