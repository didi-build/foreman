// Seam: unit, plain logic over the memory store with the real contracts (D-162). The trusted
// documentation list and the requests to add a site (ADR 0119 slice 4c, D-473 to D-475,
// src/core/docs-sites.ts): a run's site requests become Didi's approve-once requests, asked once
// across projects and never again after a Reject, at most 10 open at once; Didi's Approve adds
// the one host once, a Reject or a request for changes adds nothing, and an Approve a switch held
// is added later by the reconcile pass's step. The flows around them are in
// test/flows/docs-sites-flows.test.ts, and Postgres in test/db/docs-sites.test.ts.
import { describe, expect, it } from "vitest";

import { approvalDecision, type ApprovalChoice } from "../src/core/approvals.ts";
import {
  createDocsSites,
  DOCS_SITE_PREFIX,
  docsSiteHost,
  docsSiteTopic,
  MAX_OPEN_DOCS_SITE_REQUESTS,
  readTrustedDocsHosts,
  TRUSTED_DOCS_HOSTS,
} from "../src/core/docs-sites.ts";
import { noPendingGate } from "../src/core/guards/dispatch.ts";
import { createLibrary } from "../src/core/library.ts";
import type { GateRequest, Json, Run } from "../src/core/store.ts";
import { createReconcileFixture } from "./reconcile-fixture.ts";

const OTHER_PROJECT = "61000000-0000-4000-8000-000000000001";
const LISTED = ["nodejs.org", "vitest.dev"];

const asks = (...hosts: string[]): { siteRequests: Json } => ({
  siteRequests: hosts.map((host) => ({ host, reason: `The ${host} reference pages.` })),
});

async function fixture() {
  const f = await createReconcileFixture();
  await f.setting("dry_run", false);
  await f.setting(TRUSTED_DOCS_HOSTS, LISTED);
  await f.store.insertProject({
    id: OTHER_PROJECT,
    slug: "other",
    name: "Other",
    repo: "didi-build/other",
    linearProjectId: null,
    galleryPathOverride: null,
    privilegedPathsExtra: [],
    prodRequiresApproval: false,
    stagingUrl: null,
    deployTarget: "cloudflare",
    createdAt: f.clock.now(),
  });
  const library = createLibrary(f.deps);
  const sites = createDocsSites(f.deps);

  /** A Developer run on an item, in this project or the other one. */
  async function developerRun(projectId = f.projectId): Promise<Run> {
    const node = await f.node("in_development", { projectId });
    return f.run(node.id, "developer", 0, { projectId });
  }

  /** Every site request, in any project, oldest first. */
  const requests = () =>
    f.store.listGateRequestsByTopic(DOCS_SITE_PREFIX, { prefix: true });

  const request = async (host: string): Promise<GateRequest> => {
    const found = (await f.store.listGateRequestsByTopic(docsSiteTopic(host))).at(-1);
    if (!found) throw new Error(`no request for ${host}`);
    return found;
  };

  /** Didi's answer on the approval page, recorded as the approval step records it. */
  const answer = (gate: GateRequest, choice: ApprovalChoice) =>
    library.answerGateRequest(
      gate.id,
      approvalDecision(gate, {
        choice,
        words: choice === "approve" ? null : "Not a site runs need.",
        approvers: ["anonymous"],
      }),
    );

  const trusted = async () => (await f.store.getSetting(TRUSTED_DOCS_HOSTS))?.value;

  return { ...f, library, sites, developerRun, requests, request, answer, trusted };
}

describe("the trusted list's rule (unit, ADR 0119 slice 4c)", () => {
  it("reads a list of at most 50 canonical host names, each once, and nothing else", () => {
    expect(readTrustedDocsHosts(LISTED)).toEqual(LISTED);
    expect(readTrustedDocsHosts(undefined)).toEqual([]);
    expect(readTrustedDocsHosts(null)).toEqual([]);
    expect(readTrustedDocsHosts([])).toEqual([]);
    const fifty = Array.from({ length: 50 }, (_, i) => `docs${i}.example.com`);
    expect(readTrustedDocsHosts(fifty)).toEqual(fifty);
    for (const bad of [
      "vitest.dev",
      { vitest: true },
      [1],
      ["Vitest.dev"],
      ["vitest.dev."],
      ["https://vitest.dev"],
      ["vitest.dev/guide"],
      ["vitest.dev:443"],
      ["*.vitest.dev"],
      ["10.0.0.1"],
      ["localhost"],
      ["vitest.dev", "vitest.dev"],
      [...fifty, "docs50.example.com"],
    ] as Json[]) {
      expect(readTrustedDocsHosts(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("names a site request's topic by its host, and reads the host back only from a canonical one", () => {
    expect(docsSiteTopic("vitest.dev")).toBe("docs-site:vitest.dev");
    expect(docsSiteHost("docs-site:vitest.dev")).toBe("vitest.dev");
    for (const topic of [
      "docs-site:",
      "docs-site:Vitest.dev",
      "docs-site:10.0.0.1",
      "docs-sites:vitest.dev",
      "hold-release:vitest.dev",
    ]) {
      expect(docsSiteHost(topic), topic).toBeUndefined();
    }
  });
});

describe("a run's site requests (unit: src/core/docs-sites.ts on the memory store, ADR 0119 slice 4c)", () => {
  it("opens one approve-once request per host for Didi, on no item, with the fixed question, once per run", async () => {
    const f = await fixture();
    const run = await f.developerRun();
    const structured = {
      pullRequest: { number: 7 },
      ...asks("docs.example.dev", "react.dev"),
    };
    expect(await f.sites.submit(run, structured)).toEqual({
      step: "submitted",
      opened: 2,
      skipped: 0,
      dropped: 0,
    });
    const opened = await f.requests();
    expect(opened.map((g) => g.topicKey)).toEqual([
      "docs-site:docs.example.dev",
      "docs-site:react.dev",
    ]);
    expect(opened[0]).toMatchObject({
      projectId: f.projectId,
      nodeId: null,
      kind: "new_credentials",
      owner: "didi",
      blocking: false,
      status: "open",
      approvalUrl: null,
      payload: {
        question:
          "A Developer run asks to add docs.example.dev to the trusted documentation sites. Approve adds this one host for every run's lookup. Reject keeps it off, and it is not asked again.",
        host: "docs.example.dev",
        reason: "The docs.example.dev reference pages.",
        foundBy: { role: "developer", nodeId: run.nodeId, runId: run.id },
      },
    });
    expect(Object.keys(opened[0]?.payload as object).sort()).toEqual([
      "foundBy",
      "host",
      "question",
      "reason",
    ]);
    // On no item, so the run's item is never held up by it (`no_pending_gate`).
    const node = await f.store.getNode(run.nodeId ?? "");
    if (!node) throw new Error("no node");
    expect((await noPendingGate({ node, store: f.store })).pass).toBe(true);
    // A repeated run end opens nothing more.
    expect(await f.sites.submit(run, structured)).toEqual({
      step: "already_submitted",
      requests: 2,
    });
    expect(await f.requests()).toHaveLength(2);
  });

  it("names the role as people say it in the question", async () => {
    const f = await fixture();
    const node = await f.node("in_design_exploration", { track: "design" });
    const run = await f.run(node.id, "designer");
    await f.sites.submit(run, asks("docs.example.dev"));
    expect((await f.request("docs.example.dev")).payload).toMatchObject({
      question:
        "A Designer run asks to add docs.example.dev to the trusted documentation sites. Approve adds this one host for every run's lookup. Reject keeps it off, and it is not asked again.",
      foundBy: { role: "designer" },
    });
  });

  it("skips a listed host, a host named twice, and a host already asked about in another project", async () => {
    const f = await fixture();
    const other = await f.developerRun(OTHER_PROJECT);
    expect(await f.sites.submit(other, asks("docs.example.dev"))).toMatchObject({
      opened: 1,
    });
    const run = await f.developerRun();
    expect(
      await f.sites.submit(run, asks("vitest.dev", "react.dev", "react.dev")),
    ).toEqual({ step: "submitted", opened: 1, skipped: 2, dropped: 0 });
    expect(
      await f.sites.submit(await f.developerRun(), asks("docs.example.dev")),
    ).toEqual({ step: "submitted", opened: 0, skipped: 1, dropped: 0 });
    const opened = await f.requests();
    expect(opened.map((g) => [g.projectId, g.topicKey])).toEqual([
      [OTHER_PROJECT, "docs-site:docs.example.dev"],
      [f.projectId, "docs-site:react.dev"],
    ]);
  });

  it("never asks again after a Reject or a request for changes, in any project, but asks again after an expiry (D-475)", async () => {
    const f = await fixture();
    await f.sites.submit(
      await f.developerRun(OTHER_PROJECT),
      asks("rejected.example.dev", "changed.example.dev", "expired.example.dev"),
    );
    await f.answer(await f.request("rejected.example.dev"), "reject");
    await f.answer(await f.request("changed.example.dev"), "changes_requested");
    const expired = await f.request("expired.example.dev");
    await f.store.closeGateRequest(expired.id, {
      status: "expired",
      at: f.clock.now(),
    });
    f.advanceMinutes(60 * 24 * 30);
    const run = await f.developerRun();
    expect(
      await f.sites.submit(
        run,
        asks("rejected.example.dev", "changed.example.dev", "expired.example.dev"),
      ),
    ).toEqual({ step: "submitted", opened: 1, skipped: 2, dropped: 0 });
    expect((await f.request("expired.example.dev")).projectId).toBe(f.projectId);
    expect(
      await f.store.listGateRequestsByTopic("docs-site:rejected.example.dev"),
    ).toHaveLength(1);
  });

  it("waits for an Approve's add instead of asking again, and asks again once the list held the host and Didi took it off", async () => {
    const f = await fixture();
    await f.sites.submit(await f.developerRun(), asks("docs.example.dev"));
    const gate = await f.request("docs.example.dev");
    // Approved while dry run was on: the add is due, so a run asking for it asks nothing new.
    await f.setting("dry_run", true);
    await f.answer(gate, "approve");
    expect(await f.sites.afterAnswer(gate)).toEqual({
      host: "docs.example.dev",
      step: "dry_run",
    });
    await f.setting("dry_run", false);
    expect(
      await f.sites.submit(await f.developerRun(), asks("docs.example.dev")),
    ).toEqual({ step: "submitted", opened: 0, skipped: 1, dropped: 0 });
    expect(await f.sites.add(gate)).toEqual({
      host: "docs.example.dev",
      step: "added",
    });
    // Didi takes it off by hand: it is not added back, and a run may ask about it again.
    f.advanceMinutes(10);
    await f.setting(TRUSTED_DOCS_HOSTS, LISTED);
    expect(await f.sites.pending()).toEqual([]);
    expect(await f.sites.add(gate)).toEqual({
      host: "docs.example.dev",
      step: "already_added",
    });
    expect(await f.trusted()).toEqual(LISTED);
    expect(
      await f.sites.submit(await f.developerRun(), asks("docs.example.dev")),
    ).toEqual({ step: "submitted", opened: 1, skipped: 0, dropped: 0 });
  });

  it(`keeps at most ${MAX_OPEN_DOCS_SITE_REQUESTS} site requests open across projects, and counts the ones dropped`, async () => {
    const f = await fixture();
    // Nine open in two projects, and one request of another kind that does not count.
    for (let i = 0; i < 3; i += 1) {
      const hosts = [0, 1, 2].map((j) => `docs${i * 3 + j}.example.dev`);
      await f.sites.submit(
        await f.developerRun(i === 1 ? OTHER_PROJECT : f.projectId),
        asks(...hosts),
      );
    }
    await f.openGate((await f.node("ready_for_dev")).id, "spend:docs");
    expect((await f.requests()).filter((g) => g.status === "open")).toHaveLength(9);
    const run = await f.developerRun();
    expect(
      await f.sites.submit(
        run,
        asks("a.example.dev", "b.example.dev", "c.example.dev"),
      ),
    ).toEqual({ step: "submitted", opened: 1, skipped: 0, dropped: 2 });
    expect((await f.requests()).filter((g) => g.status === "open")).toHaveLength(10);
    // An answer frees a place for the next run's request.
    await f.answer(await f.request("a.example.dev"), "reject");
    expect(await f.sites.submit(await f.developerRun(), asks("b.example.dev"))).toEqual(
      {
        step: "submitted",
        opened: 1,
        skipped: 0,
        dropped: 0,
      },
    );
  });

  it("writes nothing under the kill switch or in dry run, without the list, with a malformed list or a bad shape", async () => {
    const f = await fixture();
    const run = await f.developerRun();
    const structured = asks("docs.example.dev");
    await f.setting("kill_switch", true);
    expect(await f.sites.submit(run, structured)).toEqual({
      step: "refused",
      reason: "kill_switch",
    });
    await f.setting("kill_switch", false);
    await f.setting("dry_run", true);
    expect(await f.sites.submit(run, structured)).toEqual({
      step: "refused",
      reason: "dry_run",
    });
    await f.setting("dry_run", false);
    await f.setting(TRUSTED_DOCS_HOSTS, ["Not A Host"]);
    expect(await f.sites.submit(run, structured)).toEqual({
      step: "refused",
      reason: "bad_list",
    });
    for (const bad of [
      [{ host: "https://docs.example.dev/", reason: "x" }],
      [{ host: "docs.example.dev", reason: "two\nlines" }],
      [{ host: "docs.example.dev" }],
      ["a.example.dev", "b.example.dev", "c.example.dev", "d.example.dev"].map(
        (host) => ({
          host,
          reason: "x",
        }),
      ),
      "docs.example.dev",
    ] as Json[]) {
      expect(
        await f.sites.submit(run, { siteRequests: bad }),
        JSON.stringify(bad),
      ).toEqual({
        step: "refused",
        reason: "bad_requests",
      });
    }
    expect(await f.sites.submit(run, {})).toEqual({ step: "none" });
    expect(await f.sites.submit(run, { siteRequests: [] })).toEqual({ step: "none" });
    expect(await f.sites.submit(run, null)).toEqual({ step: "none" });
    expect(await f.requests()).toEqual([]);
    // Without the list's row (migration 0033 not applied) nothing is opened either.
    const bare = await createReconcileFixture();
    await bare.setting("dry_run", false);
    const node = await bare.node("in_development");
    const bareRun = await bare.run(node.id, "developer");
    expect(await createDocsSites(bare.deps).submit(bareRun, structured)).toEqual({
      step: "refused",
      reason: "no_list",
    });
    expect(
      await bare.store.listGateRequestsByTopic(DOCS_SITE_PREFIX, { prefix: true }),
    ).toEqual([]);
  });
});

describe("Didi's answer on a site request (unit: src/core/docs-sites.ts on the memory store, ADR 0119 slice 4c)", () => {
  it("adds the one host on Approve, once, even when the answer's step is repeated or runs twice at once", async () => {
    const f = await fixture();
    await f.sites.submit(await f.developerRun(), asks("docs.example.dev", "react.dev"));
    const gate = await f.request("docs.example.dev");
    await f.answer(gate, "approve");
    const [first, second] = await Promise.all([
      f.sites.afterAnswer(gate),
      f.sites.afterAnswer(gate),
    ]);
    expect([first?.step, second?.step].sort()).toEqual(["added", "already_listed"]);
    expect(await f.sites.afterAnswer(gate)).toEqual({
      host: "docs.example.dev",
      step: "already_listed",
    });
    // The one host, sorted into the list, with the runner's write logged once.
    expect(await f.trusted()).toEqual(["docs.example.dev", "nodejs.org", "vitest.dev"]);
    const changes = await f.store.listSettingChanges(TRUSTED_DOCS_HOSTS);
    expect(changes.filter((c) => c.changedBy === "runner")).toEqual([
      {
        key: TRUSTED_DOCS_HOSTS,
        oldValue: LISTED,
        newValue: ["docs.example.dev", "nodejs.org", "vitest.dev"],
        changedBy: "runner",
        changedAt: f.clock.now(),
      },
    ]);
    // The other request is still open: its host is not added.
    const other = await f.request("react.dev");
    expect(other.status).toBe("open");
    expect(await f.sites.afterAnswer(other)).toEqual({
      host: "react.dev",
      step: "waiting",
    });
    expect(await f.sites.pending()).toEqual([]);
  });

  it("adds nothing on Reject or a request for changes, and a later Reject keeps an earlier Approve's host off", async () => {
    const f = await fixture();
    await f.sites.submit(
      await f.developerRun(),
      asks("rejected.example.dev", "changed.example.dev"),
    );
    for (const [host, choice] of [
      ["rejected.example.dev", "reject"],
      ["changed.example.dev", "changes_requested"],
    ] as const) {
      const gate = await f.request(host);
      await f.answer(gate, choice);
      expect(await f.sites.afterAnswer(gate)).toEqual({ host, step: "not_approved" });
    }
    expect(await f.trusted()).toEqual(LISTED);
    // An Approve a switch held, then a newer request on the topic that Didi rejected: the
    // latest answer counts, so nothing is added.
    await f.sites.submit(await f.developerRun(), asks("late.example.dev"));
    const approved = await f.request("late.example.dev");
    await f.setting("kill_switch", true);
    await f.answer(approved, "approve");
    expect(await f.sites.afterAnswer(approved)).toEqual({
      host: "late.example.dev",
      step: "kill_switch",
    });
    f.advanceMinutes(1);
    const later = await f.library.openGateRequest({
      projectId: OTHER_PROJECT,
      topicKey: docsSiteTopic("late.example.dev"),
      kind: "new_credentials",
      owner: "didi",
      blocking: false,
    });
    await f.answer(later, "reject");
    await f.setting("kill_switch", false);
    expect(await f.sites.pending()).toEqual([]);
    expect(await f.sites.add(approved)).toEqual({
      host: "late.example.dev",
      step: "not_approved",
    });
    expect(await f.trusted()).toEqual(LISTED);
  });

  it("leaves an Approve a switch held for the reconcile pass's step, which adds it once both are off", async () => {
    const f = await fixture();
    await f.sites.submit(await f.developerRun(), asks("docs.example.dev"));
    const gate = await f.request("docs.example.dev");
    await f.setting("kill_switch", true);
    await f.answer(gate, "approve");
    expect(await f.sites.afterAnswer(gate)).toEqual({
      host: "docs.example.dev",
      step: "kill_switch",
    });
    expect(await f.sites.add(gate)).toEqual({
      host: "docs.example.dev",
      step: "kill_switch",
    });
    expect(await f.trusted()).toEqual(LISTED);
    expect((await f.sites.pending()).map((g) => g.id)).toEqual([gate.id]);
    await f.setting("kill_switch", false);
    await f.setting("dry_run", true);
    expect(await f.sites.add(gate)).toEqual({
      host: "docs.example.dev",
      step: "dry_run",
    });
    await f.setting("dry_run", false);
    for (const due of await f.sites.pending()) {
      expect(await f.sites.add(due)).toEqual({
        host: "docs.example.dev",
        step: "added",
      });
    }
    expect(await f.trusted()).toEqual(["docs.example.dev", "nodejs.org", "vitest.dev"]);
    expect(await f.sites.pending()).toEqual([]);
  });

  it("refuses to add without the list, to a malformed list, to a full list, and for a request that is not a site request", async () => {
    const f = await fixture();
    await f.sites.submit(await f.developerRun(), asks("docs.example.dev"));
    const gate = await f.request("docs.example.dev");
    await f.answer(gate, "approve");
    await f.setting(TRUSTED_DOCS_HOSTS, "vitest.dev");
    expect(await f.sites.afterAnswer(gate)).toEqual({
      host: "docs.example.dev",
      step: "bad_list",
    });
    const full = Array.from({ length: 50 }, (_, i) => `docs${i}.example.com`);
    await f.setting(TRUSTED_DOCS_HOSTS, full);
    expect(await f.sites.afterAnswer(gate)).toEqual({
      host: "docs.example.dev",
      step: "list_full",
    });
    expect(await f.trusted()).toEqual(full);
    const other = await f.openGate((await f.node("ready_for_dev")).id, "spend:docs");
    expect(await f.sites.afterAnswer(other)).toEqual({ step: "not_docs_site" });
    // A request on the topic of another kind or owner is not a site request.
    const forged = await f.openGate(
      (await f.node("ready_for_dev")).id,
      "docs-site:forged.example.dev",
    );
    expect(await f.sites.afterAnswer(forged)).toEqual({
      host: "forged.example.dev",
      step: "no_request",
    });
    // Without the list's row, the add waits.
    const bare = await createReconcileFixture();
    await bare.setting("dry_run", false);
    const bareSites = createDocsSites(bare.deps);
    const bareGate = await createLibrary(bare.deps).openGateRequest({
      projectId: bare.projectId,
      topicKey: docsSiteTopic("docs.example.dev"),
      kind: "new_credentials",
      owner: "didi",
      blocking: false,
    });
    await createLibrary(bare.deps).answerGateRequest(
      bareGate.id,
      approvalDecision(bareGate, {
        choice: "approve",
        words: null,
        approvers: ["anonymous"],
      }),
    );
    expect(await bareSites.afterAnswer(bareGate)).toEqual({
      host: "docs.example.dev",
      step: "no_list",
    });
    expect(await bare.store.getSetting(TRUSTED_DOCS_HOSTS)).toBeNull();
  });
});
