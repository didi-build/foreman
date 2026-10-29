// Test support for GitHub ingestion (ADR 0113): a store with one project and one dispatched node,
// a fake GitHub holding that node's open PR, and a clock that ticks one second per reading so
// the newest row is never in doubt. Fake data only (D-178); no network.
import { createFakeGitHub, type FakeGitHub } from "../src/adapters/github/fake.ts";
import type { CheckRun, PullRequest } from "../src/core/github.ts";
import type { IngestDeps } from "../src/core/github-ingest.ts";
import { createMemoryStore } from "../src/core/memory-store.ts";
import type { Evidence, Node, Store } from "../src/core/store.ts";

export const REPO = "didi-build/rehearsal";
export const BRANCH = "foreman/item-1";
export const DEVELOPER_APP = "foreman-developer[bot]";
export const DESIGNER_APP = "foreman-designer[bot]";
export const WEBHOOK_SECRET = "test-only-webhook-secret";
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const MERGE_SHA = "c".repeat(40);
export const PR = 7;
export const CHANGED = ["src/app.ts", "docs/readme.md"];

export const RUNNER_APP = "foreman-runner";
export const ACTIONS_APP = "github-actions";

let checkRunIds = 1000;
/** A check run with a fresh id, as GitHub creates on every run and rerun. */
export const check = (
  name: string,
  status: CheckRun["status"],
  conclusion: string | null = null,
  appSlug: string | null = ACTIONS_APP,
): CheckRun => ({ id: ++checkRunIds, name, status, conclusion, appSlug });

export const passing = (...names: string[]): CheckRun[] =>
  names.map((name) => check(name, "completed", "success"));

export interface IngestFixture {
  store: Store;
  github: FakeGitHub;
  deps: IngestDeps;
  projectId: string;
  nodeId: string;
  /** Adds a node dispatched on `branch` (the runner's dispatch record, M3.2). */
  dispatchNode(branch: string, repo?: string): Promise<string>;
  /** Records a newer dispatch for an existing node. */
  redispatch(nodeId: string, branch: string): Promise<void>;
  /** The open PR as the fake holds it now. */
  pr(): Promise<PullRequest>;
  evidence(kind?: Evidence["kind"]): Promise<Evidence[]>;
  nextDeliveryId(): string;
}

export async function createIngestFixture(
  options: { store?: Store; idPrefix?: string } = {},
): Promise<IngestFixture> {
  const store = options.store ?? createMemoryStore();
  const prefix = options.idPrefix ?? "00000000-0000-4000-8000";
  let n = 0;
  const nextId = (): string => `${prefix}-${String(++n).padStart(12, "0")}`;
  let tick = 0;
  const clock = {
    now: () => new Date(Date.UTC(2026, 9, 29, 12, 0, tick++)),
  };
  const github = createFakeGitHub({ webhookSecret: WEBHOOK_SECRET });
  const deps: IngestDeps = {
    store,
    github,
    clock,
    ids: { next: nextId },
    appLogins: [DEVELOPER_APP, DESIGNER_APP],
    runnerAppSlug: RUNNER_APP,
  };

  const projectId = nextId();
  await store.insertProject({
    id: projectId,
    slug: `rehearsal-${prefix.slice(0, 8)}`,
    name: "Rehearsal",
    repo: REPO,
    linearProjectId: null,
    galleryPathOverride: null,
    privilegedPathsExtra: [],
    prodRequiresApproval: false,
    stagingUrl: null,
    createdAt: clock.now(),
  });

  async function record(nodeId: string, repo: string, branch: string): Promise<void> {
    await store.insertEvidence({
      id: nextId(),
      nodeId,
      runId: null,
      kind: "dispatch_record",
      ref: `dispatch/${branch}`,
      commitSha: null,
      payload: { repo, branch },
      recordedBy: "runner",
      recordedAt: clock.now(),
      supersedesId: null,
    });
  }

  async function dispatchNode(branch: string, repo = REPO): Promise<string> {
    const at = clock.now();
    const node: Node = {
      id: nextId(),
      projectId,
      type: "work_item",
      track: "code",
      state: "in_development",
      substate: null,
      ownerRole: "developer",
      title: "An item",
      body: {},
      hold: false,
      agentReady: true,
      stale: false,
      blockedReason: null,
      stateSince: at,
      linearIssueId: null,
      linearStatusSynced: null,
      version: 0,
      createdAt: at,
      updatedAt: at,
    };
    await store.insertNode(node);
    await record(node.id, repo, branch);
    return node.id;
  }

  const nodeId = await dispatchNode(BRANCH);
  github.putPullRequest({
    repo: REPO,
    number: PR,
    state: "open",
    merged: false,
    mergeCommitSha: null,
    headSha: SHA_A,
    headBranch: BRANCH,
    headRepo: REPO,
    author: DEVELOPER_APP,
  });
  github.setChangedPaths(REPO, PR, CHANGED);
  github.setCheckRuns(REPO, SHA_A, [check("build", "in_progress")]);

  let deliveries = 0;
  return {
    store,
    github,
    deps,
    projectId,
    nodeId,
    dispatchNode,
    redispatch: (id, branch) => record(id, REPO, branch),
    pr: async () => (await github.getPullRequest(REPO, PR))!,
    evidence: async (kind) =>
      (await store.listEvidence({ nodeId, kind })).filter(
        (e) => e.kind !== "dispatch_record",
      ),
    nextDeliveryId: () => `${prefix.slice(0, 8)}-delivery-${++deliveries}`,
  };
}
