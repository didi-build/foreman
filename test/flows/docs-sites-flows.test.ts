// Seam: the run-end, approval resume and reconcile flows with a fake agent runtime on the memory
// store and the real contracts and guards, for the documentation sites a run asks Didi to trust
// (ADR 0119 slice 4c, D-473 to D-475, src/core/docs-sites.ts): a Developer run whose bot file
// declares the lookup opens one request per site at its end, beside its findings, and its item
// moves on as before; Didi's Approve adds the one host once and a Reject adds nothing; an Approve
// a switch held is added by the reconcile flow's pass once both are off. The core's rules are in
// test/docs-sites.test.ts, and Postgres in test/db/docs-sites.test.ts.
import { describe, expect, it } from "vitest";

import { run as resume } from "../../flows/approval-resume.ts";
import { run as dispatch } from "../../flows/dispatch.ts";
import { run as reconcileFlow } from "../../flows/reconcile.ts";
import { run as recordRunEnd } from "../../flows/record-run-end.ts";
import type { AgentRunResult } from "../../src/adapters/agent-runtime/runtime.ts";
import {
  DOCS_SITE_PREFIX,
  docsSiteTopic,
  TRUSTED_DOCS_HOSTS,
} from "../../src/core/docs-sites.ts";
import { HEAD } from "../reconcile-fixture.ts";
import { createFlowFixture, type FlowFixture } from "./flow-fixture.ts";

const LISTED = ["nodejs.org", "vitest.dev"];

const RESULT: AgentRunResult = {
  outcome: "success",
  detail: "done",
  finalText: "never stored",
  turns: 12,
  costUsd: 0.4,
  minutes: 6,
  tokens: { uncachedInput: 100, cachedInput: 900, output: 50 },
  model: "claude-sonnet-5-5",
};

const asking = (...hosts: string[]): AgentRunResult => ({
  ...RESULT,
  structured: {
    pullRequest: { number: 7 },
    siteRequests: hosts.map((host) => ({ host, reason: `The ${host} API pages.` })),
  },
});

/** The flow fixture, live, with the trusted list and the Developer's bot file declaring the lookup. */
async function fixture(declared = true) {
  const f = await createFlowFixture();
  await f.live();
  await f.setting(TRUSTED_DOCS_HOSTS, LISTED);
  if (declared) {
    f.deps.bots = {
      ...f.deps.bots,
      developer: { ...f.deps.bots.developer, docsLookup: true },
    };
  }
  return f;
}

/** A Developer run on an item, with the evidence its done report needs. */
async function developerDone(f: FlowFixture) {
  const node = await f.node("ready_for_dev");
  const started = await dispatch(f.deps, { nodeId: node.id, role: "developer" });
  if (started.outcome !== "started") throw new Error("the Developer was not started");
  await f.evidence(
    node.id,
    "ci_run",
    { conclusion: "success", pr: 7, changedPaths: ["src/a.ts"] },
    { commitSha: HEAD },
  );
  await f.evidence(node.id, "docs_note", { impact: "none" }, { commitSha: HEAD });
  return { node, runId: started.runId };
}

const siteRequests = (f: FlowFixture) =>
  f.store.listGateRequestsByTopic(DOCS_SITE_PREFIX, { prefix: true });

/** Didi's answer on the approval page, as Windmill hands it to the resume step. */
const answerPage = (
  f: FlowFixture,
  gateRequestId: string,
  decision: string,
  feedback = "",
) =>
  resume(f.deps, {
    gateRequestId,
    resume: { decision, options: [], feedback },
    approvers: ["anonymous"],
  });

const trusted = async (f: FlowFixture) =>
  (await f.store.getSetting(TRUSTED_DOCS_HOSTS))?.value;

describe("the run-end flow with a run's site requests (flow: fake adapters, ADR 0119 slice 4c)", () => {
  it("opens one request per site for a role whose bot file declares the lookup, on no item, and the item moves on as before", async () => {
    const f = await fixture();
    const { node, runId } = await developerDone(f);
    f.runtime.status.set(runId, {
      state: "finished",
      result: asking("docs.example.dev", "vitest.dev"),
    });
    expect(await recordRunEnd(f.deps, { runId })).toMatchObject({
      outcome: "recorded",
      report: { outcome: "success" },
      move: { outcome: "applied", toState: "in_qa_review" },
      docsSites: { step: "submitted", opened: 1, skipped: 1, dropped: 0 },
    });
    const [request] = await siteRequests(f);
    expect(request).toMatchObject({
      projectId: f.projectId,
      nodeId: null,
      topicKey: "docs-site:docs.example.dev",
      kind: "new_credentials",
      owner: "didi",
      blocking: false,
      status: "open",
      payload: {
        host: "docs.example.dev",
        reason: "The docs.example.dev API pages.",
        foundBy: { role: "developer", nodeId: node.id, runId },
      },
    });
    expect(await siteRequests(f)).toHaveLength(1);
    // The open request names no item, so QA's run on the item starts as usual.
    expect((await f.store.getNode(node.id))?.state).toBe("in_qa_review");
    expect(
      (await f.store.listRuns({ nodeId: node.id })).filter((r) => r.bot === "qa"),
    ).toHaveLength(1);
    // A repeated run-end trigger opens nothing more.
    expect(await recordRunEnd(f.deps, { runId })).toMatchObject({
      outcome: "already_recorded",
    });
    expect(await siteRequests(f)).toHaveLength(1);
  });

  it("opens none for a bot file that does not declare the lookup", async () => {
    const plain = await fixture(false);
    const first = await developerDone(plain);
    plain.runtime.status.set(first.runId, {
      state: "finished",
      result: asking("docs.example.dev"),
    });
    const ended = await recordRunEnd(plain.deps, { runId: first.runId });
    expect(ended).toMatchObject({
      outcome: "recorded",
      report: { outcome: "success" },
    });
    expect(ended).not.toHaveProperty("docsSites");
    expect(await siteRequests(plain)).toEqual([]);
  });
});

describe("Didi's answer on a site request (flow: fake adapters, ADR 0119 slice 4c)", () => {
  async function asked(f: FlowFixture, host = "docs.example.dev") {
    const { runId } = await developerDone(f);
    f.runtime.status.set(runId, { state: "finished", result: asking(host) });
    await recordRunEnd(f.deps, { runId });
    const [request] = await f.store.listGateRequestsByTopic(docsSiteTopic(host));
    if (!request) throw new Error("no site request");
    return request;
  }

  it("adds the one host on Approve, once, and a repeated answer records nothing", async () => {
    const f = await fixture();
    const request = await asked(f);
    expect(await answerPage(f, request.id, "Approve")).toMatchObject({
      outcome: "recorded",
      heldBy: null,
      docsSite: { host: "docs.example.dev", step: "added" },
    });
    expect(await trusted(f)).toEqual(["docs.example.dev", "nodejs.org", "vitest.dev"]);
    expect(await answerPage(f, request.id, "Approve")).toEqual({
      outcome: "already_closed",
    });
    expect(await trusted(f)).toEqual(["docs.example.dev", "nodejs.org", "vitest.dev"]);
    expect((await reconcileFlow(f.deps)).docsSites).toEqual([]);
  });

  it("adds nothing on Reject, and the host is not asked again", async () => {
    const f = await fixture();
    const request = await asked(f);
    expect(
      await answerPage(f, request.id, "Reject", "Not a site we need."),
    ).toMatchObject({
      outcome: "recorded",
      docsSite: { host: "docs.example.dev", step: "not_approved" },
    });
    expect(await trusted(f)).toEqual(LISTED);
    await asked(f);
    expect(
      await f.store.listGateRequestsByTopic(docsSiteTopic("docs.example.dev")),
    ).toHaveLength(1);
  });

  it("records an Approve under dry run and adds the host in the reconcile flow's pass once the runner is live", async () => {
    const f = await fixture();
    const request = await asked(f);
    await f.setting("dry_run", true);
    expect(await answerPage(f, request.id, "Approve")).toMatchObject({
      outcome: "recorded",
      heldBy: "dry_run",
      docsSite: { host: "docs.example.dev", step: "dry_run" },
    });
    expect(await trusted(f)).toEqual(LISTED);
    // In dry run the pass does not run.
    expect((await reconcileFlow(f.deps)).docsSites).toBeNull();
    await f.live();
    expect((await reconcileFlow(f.deps)).docsSites).toEqual([
      { host: "docs.example.dev", step: "added" },
    ]);
    expect(await trusted(f)).toEqual(["docs.example.dev", "nodejs.org", "vitest.dev"]);
    expect((await reconcileFlow(f.deps)).docsSites).toEqual([]);
  });
});
