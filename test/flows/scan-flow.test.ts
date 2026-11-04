// Seam: the scan flow f/foreman/scan (D-299, D-300, O-92) with fake adapters on the memory store.
// The checks are tested in src/core/scan.test.ts and the filing in test/scan-ideas.test.ts; this
// covers what the flow adds: every project scanned once, the switches checked before any Job, the
// runner App's refusal recording nothing, a failure recorded by its step only, and the daily check
// showing what the scan found. And over two days (D-301, O-93): a new finding folded into an open
// idea, an idea in Submitted no longer found withdrawn, one further along recorded with the Council
// asked, and the daily check's lines for each. Synthetic data only; no cluster, network or token.
import { describe, expect, it } from "vitest";

import { run as dailyCheck } from "../../flows/daily-check.ts";
import { runnerRepoScans } from "../../flows/lib/compose.ts";
import { run as scanFlow } from "../../flows/scan.ts";
import { RepoMapJobError } from "../../src/adapters/agent-runtime/kubernetes/repo-maps.ts";
import { GitHubReadError } from "../../src/adapters/github/runner-app-tokens.ts";
import { SCAN_CHECKS, ScanResultError, type RepoScan } from "../../src/core/scan.ts";
import { REPO } from "../reconcile-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const SHA = "c".repeat(40);

function scanOf(targets: string[]): RepoScan {
  const counts = Object.fromEntries(
    SCAN_CHECKS.map((c) => [c, 0]),
  ) as RepoScan["counts"];
  counts.doc_link_missing = targets.length;
  return {
    commitSha: SHA,
    counts,
    findings: targets.map((target, i) => ({
      check: "doc_link_missing",
      path: `docs/guide-${i + 1}.md`,
      line: i + 1,
      target,
    })),
    notRun: [],
  };
}

async function secondProject(f: FlowFixture) {
  const id = f.deps.ids.next();
  await f.store.insertProject({
    id,
    slug: "second",
    name: "Second",
    repo: "didi-build/second",
    linearProjectId: null,
    galleryPathOverride: null,
    privilegedPathsExtra: [],
    prodRequiresApproval: false,
    stagingUrl: null,
    createdAt: f.clock.now(),
  });
  return id;
}

const ideasIn = async (f: FlowFixture, projectId: string) =>
  (await f.store.listNodes({ projectId })).filter((n) => n.type === "idea");

describe("the scan flow (flow: fake adapters, D-300, O-92)", () => {
  it("scans every project once and files each project's new findings as ideas there", async () => {
    const f = await createFlowFixture();
    await f.live();
    const second = await secondProject(f);
    f.repoScans.put(REPO, scanOf(["docs/a.md", "docs/b.md"]));
    f.repoScans.put("didi-build/second", scanOf([]));
    const result = await scanFlow(f.deps);
    // Windmill keeps the result as JSON: it survives the round trip.
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      outcome: "scanned",
      note: null,
      projects: [
        {
          slug: "rehearsal",
          outcome: "filed",
          commitSha: SHA,
          summary: { findings: 2, merged: 0, overCap: 0 },
        },
        { slug: "second", outcome: "filed", summary: { findings: 0, newIdeas: [] } },
      ],
    });
    expect(f.repoScans.scans).toEqual([REPO, "didi-build/second"]);
    expect(await ideasIn(f, f.projectId)).toHaveLength(2);
    expect(await ideasIn(f, second)).toEqual([]);
    expect(await f.store.getLatestScan(second)).toMatchObject({ outcome: "scanned" });
    // The next day's scan of the same findings merges them.
    f.advanceMinutes(24 * 60);
    const again = await scanFlow(f.deps);
    expect(again.projects[0]).toMatchObject({ summary: { merged: 2, newIdeas: [] } });
    expect(await ideasIn(f, f.projectId)).toHaveLength(2);
  });

  it.each([
    ["dry run", async (f: FlowFixture) => f.setting("dry_run", true), "dry_run"],
    ["the kill switch", (f: FlowFixture) => f.killed(), "kill_switch"],
  ] as const)(
    "under %s starts no scan and records nothing",
    async (_label, set, outcome) => {
      const f = await createFlowFixture();
      await set(f);
      f.repoScans.put(REPO, scanOf(["docs/a.md"]));
      const result = await scanFlow(f.deps);
      expect(result).toMatchObject({ outcome, projects: [] });
      expect(result.note).toMatch(/no scan ran and nothing was recorded/);
      expect(f.repoScans.scans).toEqual([]);
      expect(await ideasIn(f, f.projectId)).toEqual([]);
      expect(await f.store.getLatestScan(f.projectId)).toBeNull();
    },
  );

  it("until the runner App exists, refuses on the token, reads no cluster, records nothing and says so", async () => {
    const f = await createFlowFixture();
    await f.live();
    let clusterReads = 0;
    const result = await scanFlow({
      ...f.deps,
      repoScans: runnerRepoScans(async () => {
        clusterReads += 1;
        throw new Error("the cluster is not read before a token exists");
      }),
    });
    expect(result.outcome).toBe("not_built");
    expect(result.note).toMatch(
      /nothing was recorded: The runner App's read-only token/,
    );
    expect(result.projects).toEqual([]);
    expect(clusterReads).toBe(0);
    expect(await f.store.getLatestScan(f.projectId)).toBeNull();
    expect(await ideasIn(f, f.projectId)).toEqual([]);
  });

  it.each([
    [
      "a failed Job",
      new RepoMapJobError("the scan Job failed: secret-looking text"),
      "job",
    ],
    [
      "a refused result",
      new ScanResultError("the scan result is not sorted"),
      "result",
    ],
    [
      "a GitHub read",
      new GitHubReadError("reading the repository failed with 500"),
      "github",
    ],
    ["anything else", new Error("boom with secret-looking text"), "other"],
  ] as const)(
    "records %s by its step's fixed name, never its text, and goes on to the next project",
    async (_label, error, failure) => {
      const f = await createFlowFixture();
      await f.live();
      const second = await secondProject(f);
      f.repoScans.put(REPO, error);
      f.repoScans.put("didi-build/second", scanOf(["docs/a.md"]));
      const result = await scanFlow(f.deps);
      expect(result.projects).toEqual([
        { slug: "rehearsal", outcome: "failed", failure, recorded: true },
        expect.objectContaining({ slug: "second", outcome: "filed" }),
      ]);
      expect(JSON.stringify(result)).not.toContain("secret-looking");
      const record = await f.store.getLatestScan(f.projectId);
      expect(record).toMatchObject({ outcome: "failed", summary: { failure } });
      expect(JSON.stringify(record)).not.toContain("secret-looking");
      expect(await ideasIn(f, second)).toHaveLength(1);
    },
  );

  it("folds in, withdraws and asks the Council over two days, and the daily check shows each (D-301)", async () => {
    const f = await createFlowFixture();
    await f.live();
    const link = (path: string, target: string, line = 1) => ({
      check: "doc_link_missing" as const,
      path,
      line,
      target,
    });
    const day1 = [
      link("docs/a.md", "docs/x.md"),
      link("docs/b.md", "docs/y.md"),
      link("docs/c.md", "docs/z.md"),
    ];
    const counts = (n: number) => ({ ...scanOf([]).counts, doc_link_missing: n });
    f.repoScans.put(REPO, {
      commitSha: SHA,
      counts: counts(3),
      findings: day1,
      notRun: [],
    });
    await scanFlow(f.deps);
    const ideas = await ideasIn(f, f.projectId);
    const byPath = (p: string) =>
      ideas.find(
        (i) => (i.body as { evidence: { path: string }[] }).evidence[0]?.path === p,
      );
    const [a, b, c] = [byPath("docs/a.md"), byPath("docs/b.md"), byPath("docs/c.md")];
    // The idea on docs/c.md moved on to Council planning.
    await f.store.changeNodeState(c?.id ?? "", 0, {
      state: "council_planning",
      substate: null,
      ownerRole: "council",
      blockedReason: null,
      stateSince: f.clock.now(),
      updatedAt: f.clock.now(),
    });
    f.advanceMinutes(24 * 60);
    const LATER = "d".repeat(40);
    const day2 = [link("docs/a.md", "docs/w.md", 9), link("docs/a.md", "docs/x.md")];
    f.repoScans.put(REPO, {
      commitSha: LATER,
      counts: counts(2),
      findings: day2,
      notRun: [],
    });
    const result = await scanFlow(f.deps);
    expect(result.projects[0]).toMatchObject({
      outcome: "filed",
      commitSha: LATER,
      summary: {
        merged: 1,
        newIdeas: [],
        folded: [{ nodeId: a?.id }],
        gone: [
          { nodeId: b?.id, action: "withdraw" },
          { nodeId: c?.id, action: "asked_council" },
        ],
      },
      withdrawals: [{ nodeId: b?.id, outcome: "applied" }],
    });
    expect((await f.store.getNode(b?.id ?? ""))?.state).toBe("rejected");
    expect((await f.store.getNode(c?.id ?? ""))?.state).toBe("council_planning");
    expect(
      await f.store.findOpenGateRequest(f.projectId, `scanner-gone:${c?.id}`),
    ).toMatchObject({ owner: "council", kind: "council_question" });
    f.advanceMinutes(60);
    const { check, text } = await dailyCheck(f.deps);
    expect(check.projects[0]?.scan).toMatchObject({
      foldedInto: [{ nodeId: a?.id, title: a?.title, findings: 1 }],
      withdrawn: [{ nodeId: b?.id, title: b?.title }],
      notWithdrawn: [],
      askedCouncil: [{ nodeId: c?.id, title: c?.title, state: "council_planning" }],
    });
    expect(text).toContain(
      "2 findings (doc_link_missing 2); 0 new ideas, 1 merged as duplicates, 1 folded into open ideas, 0 over the cap of 5.",
    );
    expect(text).toContain(
      `- folded into "Broken link in docs/a.md to docs/x.md" (item ${a?.id}): 1 new finding`,
    );
    expect(text).toContain(
      `- withdrawn "Broken link in docs/b.md to docs/y.md" (item ${b?.id}): no longer found, moved from Submitted to Rejected; Didi can reopen it`,
    );
    expect(text).toContain(
      `- no longer found, asked the Council: "Broken link in docs/c.md to docs/z.md" (item ${c?.id}), in council_planning`,
    );
  });

  it("is shown in the next daily check: when it ran, what it found and which ideas those became", async () => {
    const f = await createFlowFixture();
    await f.live();
    // Six new findings: five ideas and one over the cap.
    f.repoScans.put(
      REPO,
      scanOf([
        "docs/a.md",
        "docs/b.md",
        "docs/c.md",
        "docs/d.md",
        "docs/e.md",
        "docs/f.md",
      ]),
    );
    await scanFlow(f.deps);
    f.advanceMinutes(60);
    const { check, text } = await dailyCheck(f.deps);
    const [project] = check.projects;
    const ideas = await ideasIn(f, f.projectId);
    expect(project?.scan).toMatchObject({
      outcome: "scanned",
      commitSha: SHA,
      findings: 6,
      merged: 0,
      overCap: 1,
      cap: 5,
      findingsByCheck: { doc_link_missing: 6 },
    });
    expect(project?.scan.newIdeas.map((i) => i.nodeId).sort()).toEqual(
      ideas.map((i) => i.id).sort(),
    );
    expect(text).toContain(
      `Scan: last ran 2026-10-31 08:00 UTC at commit ${SHA.slice(0, 12)}: 6 findings (doc_link_missing 6); 5 new ideas, 0 merged as duplicates, 0 folded into open ideas, 1 over the cap of 5.`,
    );
    expect(text).toContain(
      `- new idea "Broken link in docs/guide-1.md to docs/a.md" (item ${ideas[0]?.id}), drift, doc_link_missing`,
    );
  });
});
