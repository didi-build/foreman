// Test support for the runner's merge (build plan M3.3): one item in In QA review on the reconcile
// fixture, its dispatch record and builder run, its PR on the fake GitHub, and a builder for
// everything QA's pass needs on a head commit. Fake data only.
import type { GitHub } from "../src/core/github.ts";
import { createMerges } from "../src/core/merge.ts";
import type { Node, Store, Track } from "../src/core/store.ts";
import {
  createReconcileFixture,
  DEVELOPER_APP,
  HEAD,
  REPO,
} from "./reconcile-fixture.ts";

export const NEW = "f".repeat(40);
export const PR = 7;
/** QA runs on another model than the builder (ADR 0112, D-158). */
const QA_MODEL = "gpt-5-qa";

export async function setupMerge(
  options: {
    track?: Track;
    paths?: string[];
    dryRun?: boolean;
    store?: Store;
    idPrefix?: string;
    slug?: string;
    /** The PR number; the merge commit's ingest key names it, so it is unique per database. */
    pr?: number;
  } = {},
) {
  const f = await createReconcileFixture({
    prodRequiresApproval: true,
    ...(options.store ? { store: options.store } : {}),
    ...(options.idPrefix ? { idPrefix: options.idPrefix } : {}),
    ...(options.slug ? { slug: options.slug } : {}),
  });
  await f.setting("dry_run", options.dryRun ?? false);
  const track = options.track ?? "code";
  const pr = options.pr ?? PR;
  const node = await f.node("in_qa_review", { ownerRole: "qa", track });
  const branch = `foreman/${node.id}`;
  await f.evidence(node.id, "dispatch_record", { repo: REPO, branch });
  await f.run(node.id, track === "design" ? "designer" : "developer", 30);
  f.github.putPullRequest({
    repo: REPO,
    number: pr,
    state: "open",
    merged: false,
    mergeCommitSha: null,
    headSha: HEAD,
    headBranch: branch,
    headRepo: REPO,
    author: DEVELOPER_APP,
  });

  /** Everything QA's pass needs on a head commit, as the runner and the state API record it. */
  async function passedOn(sha: string, paths = options.paths ?? ["src/a.ts"]) {
    const ciId = await f.evidence(
      node.id,
      "ci_run",
      { conclusion: "success", pr, changedPaths: paths },
      { commitSha: sha },
    );
    await f.evidence(node.id, "preview_check", { pass: true }, { commitSha: sha });
    if (track === "design") {
      await f.evidence(
        node.id,
        "visual_comparison",
        { pass: true },
        { commitSha: sha },
      );
    }
    await f.evidence(node.id, "docs_note", { impact: "none" }, { commitSha: sha });
    const qa = await f.run(node.id, "qa", 5, { model: QA_MODEL, headSha: sha });
    await f.store.endRun(qa.id, {
      endedAt: f.clock.now(),
      outcome: "success",
      turns: 3,
      minutes: 5,
      costUsd: 0.1,
      tokens: null,
      transcriptRef: null,
      usageExhaustedCause: null,
      retryAfterSeconds: null,
      serviceTierServed: null,
      capacityRetries: null,
      capacityWaitSeconds: null,
      firstTokenMs: null,
      reportedCostUsd: null,
    });
    await f.evidence(
      node.id,
      "qa_verdict",
      { verdict: "pass", findings: [], evidenceIds: [ciId] },
      { commitSha: sha, runId: qa.id },
    );
    return qa;
  }

  const merges = (store: Store = f.store, github: GitHub = f.github) =>
    createMerges({ ...f.deps, store, github });
  const state = async () => ((await f.store.getNode(node.id)) as Node).state;
  const kinds = async (kind: "merge_commit" | "merge_check") =>
    f.store.listEvidence({ nodeId: node.id, kind });
  const trigger = { kind: "bot_report" as const, ref: "run:test" };
  return { ...f, node, passedOn, merges, state, kinds, trigger };
}
