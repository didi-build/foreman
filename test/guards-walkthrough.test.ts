// Seam: the real contracts with the REAL guards (M2.2). A code item walks from Ready for dev to
// Done on the memory store, with realistic evidence recorded the way the runner (M2.3) and the
// state API will record it. Each move is first tried without its evidence and must be refused.
import { describe, expect, it } from "vitest";

import { loadContractFiles } from "../src/adapters/contracts-file/load.ts";
import { validateContracts } from "../src/core/contracts.ts";
import { GUARD_NAMES, GUARDS } from "../src/core/guards/index.ts";
import { createLibrary, type Clock, type IdSource } from "../src/core/library.ts";
import { createMemoryStore } from "../src/core/memory-store.ts";
import { testRouteColumns } from "../src/core/routing-testing.ts";
import type { EvidenceKind, Json } from "../src/core/store.ts";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const RUNNER = { kind: "runner" as const, id: "runner" };
const EVENT = { kind: "event" as const, ref: null };

function clock(): Clock {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 29, 0, 0, tick++)) };
}

function ids(): IdSource {
  let n = 0;
  return { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
}

describe("code track with the real guards (integration: contracts, library and guards, M2.2)", () => {
  it("walks to Done only as the evidence arrives", async () => {
    const { contracts, problems } = validateContracts(
      loadContractFiles("d".repeat(40)).raw,
      GUARD_NAMES,
    );
    expect(problems).toEqual([]);
    const store = createMemoryStore();
    const time = clock();
    await store.insertProject({
      id: PROJECT,
      slug: "rehearsal",
      name: "Rehearsal",
      repo: "didi-build/rehearsal",
      linearProjectId: null,
      galleryPathOverride: null,
      privilegedPathsExtra: [],
      prodRequiresApproval: true,
      stagingUrl: null,
      createdAt: time.now(),
    });
    for (const [key, value] of [
      ["kill_switch", false],
      ["dry_run", false],
      ["failure_threshold", 3],
      ["qa_round_cap", 3],
    ] as const) {
      await store.setSetting({ key, value, updatedBy: "test", updatedAt: time.now() });
    }
    const library = createLibrary({
      store,
      contracts: contracts as NonNullable<typeof contracts>,
      guards: GUARDS,
      clock: time,
      ids: ids(),
    });
    const node = await library.createNode({
      projectId: PROJECT,
      type: "work_item",
      track: "code",
      state: "ready_for_dev",
      ownerRole: "developer",
      title: "Add the login page",
      agentReady: true,
    });

    const move = (toState: string) =>
      library.requestTransition({
        nodeId: node.id,
        toState,
        trigger: EVENT,
        actor: RUNNER,
      });
    const record = (
      kind: EvidenceKind,
      commitSha: string | null,
      payload: Json,
      runId: string | null = null,
    ) =>
      library.recordEvidence({
        nodeId: node.id,
        runId,
        kind,
        ref: kind,
        commitSha,
        payload,
        recordedBy: "runner",
      });
    let runs = 0;
    const run = async (bot: string, model: string) => {
      const runId = `00000000-0000-4000-9000-${String(++runs).padStart(12, "0")}`;
      await store.insertRun({
        id: runId,
        projectId: PROJECT,
        nodeId: node.id,
        bot,
        agentId: null,
        runtime: "claude_code",
        model,
        headSha: HEAD,
        prNumber: null,
        botVersion: "v1",
        startedAt: time.now(),
        endedAt: null,
        outcome: null,
        turns: null,
        minutes: null,
        costUsd: null,
        tokens: null,
        budget: {},
        parentRunId: null,
        transcriptRef: null,
        usageExhaustedCause: null,
        retryAfterSeconds: null,
        ...testRouteColumns(bot),
      });
      return runId;
    };

    expect((await move("in_development")).outcome).toBe("applied");
    await run("developer", "claude-model-a");

    expect((await move("in_qa_review")).reason).toBe("guard_failed");
    const ci = await record("ci_run", HEAD, {
      conclusion: "success",
      pr: 12,
      changedPaths: ["src/login.ts"],
    });
    expect((await move("in_qa_review")).reason).toBe("guard_failed");
    await record("docs_note", null, { impact: "none" });
    expect((await move("in_qa_review")).outcome).toBe("applied");

    expect((await move("verifying_on_staging")).reason).toBe("guard_failed");
    const preview = await record("preview_check", HEAD, { pass: true });
    const qaRun = await run("qa", "claude-model-b");
    await record(
      "qa_verdict",
      HEAD,
      { verdict: "pass", findings: [], evidenceIds: [ci.id, preview.id] },
      qaRun,
    );
    // The merge guard also needs GitHub's mergeable state on the head (D-218, M3.3).
    const blocked = await move("verifying_on_staging");
    expect(blocked.guardReport.filter((c) => !c.pass).map((c) => c.name)).toEqual([
      "no_merge_conflict_on_head",
    ]);
    await record("merge_check", HEAD, { pr: 12, mergeable: true });
    const pass = await move("verifying_on_staging");
    expect(pass.outcome, JSON.stringify(pass.guardReport)).toBe("applied");

    expect((await move("done")).reason).toBe("guard_failed");
    await record("merge_commit", MERGE, { pr: 12 });
    await record("staging_check", MERGE, { pass: true });
    expect((await move("done")).outcome).toBe("applied");
    expect((await store.getNode(node.id))?.state).toBe("done");
  });
});
