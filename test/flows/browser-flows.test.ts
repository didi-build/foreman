// Seam: the dispatch flow for QA's review with the browser (ADR 0119 slice 5c, D-476 to D-479), on
// the memory store with the real machine-2 contracts and guards, the real bot files, the real task
// source (flows/lib/tasks.ts) and the real Kubernetes runtime over its in-memory client, with a
// fake read of CI's `qa-site` builds. A QA bot file that declares the browser has the head's site
// read and checked (src/core/qa-site.ts): a site gives a browser run, with its run spec, its site
// Secret and, beside the agent, its browser pod and FOREMAN_BROWSER_URL; no site gives QA's input
// the line "No browser in this run: <reason>." and no browser object. A bot file that declares no
// browser reads no site at all. No bot file declares it yet (slice 5e), so each test declares it on
// the bot profile and the bot file it gives the flow.
import { describe, expect, it } from "vitest";

import { createTaskSource } from "../../flows/lib/tasks.ts";
import { run as dispatch } from "../../flows/dispatch.ts";
import { createFakeKubernetes } from "../../src/adapters/agent-runtime/kubernetes/fake.ts";
import { SETTINGS } from "../../src/adapters/agent-runtime/kubernetes/fixtures.ts";
import { runNames } from "../../src/adapters/agent-runtime/kubernetes/names.ts";
import type {
  Job,
  Secret,
} from "../../src/adapters/agent-runtime/kubernetes/objects.ts";
import {
  createKubernetesRuntime,
  type KubernetesRunHandle,
} from "../../src/adapters/agent-runtime/kubernetes/runtime.ts";
import { readBotFiles } from "../../src/adapters/contracts-file/bot-files.ts";
import { QA_SITE_REASONS } from "../../src/core/qa-site.ts";
import { REPO } from "../reconcile-fixture.ts";
import { createFlowFixture, HEAD, type FlowFixture } from "./flow-fixture.ts";

const DIGEST = `@sha256:${"c".repeat(64)}`;
// Fake values, shaped like credentials so a leak would be found. Not real.
const MODEL_KEY = "model-key-value-not-real-0123456789";
const GITHUB_TOKEN = "github-token-value-not-real-0123456789";
const PREVIEW_RUN = 4242;
const ZIP = new Uint8Array(Buffer.from("PK\u0005\u0006fixture-site-zip"));
const ZIP_BASE64 = Buffer.from(ZIP).toString("base64");

/** A site CI kept for the head: its root page and the head's marker. */
const SITE_ENTRIES = [
  { path: "index.html", bytes: Buffer.from("<h1>Home</h1>"), symlink: false },
  { path: "foreman-commit.txt", bytes: Buffer.from(`${HEAD}\n`), symlink: false },
];

/**
 * A QA item at its head, with the evidence the site check reads: CI's run naming the changed
 * paths and a passing preview check of run `PREVIEW_RUN`, and the pull request's change.
 */
async function qaItem(f: FlowFixture, changedPaths = ["src/health.ts"]) {
  const node = await f.node("in_qa_review");
  await f.evidence(
    node.id,
    "ci_run",
    { conclusion: "success", pr: 7, changedPaths },
    { commitSha: HEAD },
  );
  await f.evidence(
    node.id,
    "preview_check",
    { pass: true, conclusion: "success", pr: 7, workflowRunId: PREVIEW_RUN, jobId: 9 },
    { commitSha: HEAD },
  );
  f.github.setChange(REPO, 7, HEAD, {
    headSha: HEAD,
    mergeBaseSha: "a".repeat(40),
    files: [
      {
        path: "src/health.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        previousPath: null,
        patch: "@@ -0,0 +1 @@\n+export const ok = true;",
      },
    ],
    complete: true,
  });
  return {
    node,
    input: { nodeId: node.id, role: "qa" as const, prNumber: 7, headSha: HEAD },
  };
}

/**
 * The flow's real task source and Kubernetes runtime over the in-memory client, with QA's bot
 * file and profile declaring the browser when asked.
 */
function realRuns(f: FlowFixture, declared: boolean) {
  const bots = readBotFiles();
  const client = createFakeKubernetes();
  if (declared) {
    bots.qa = { ...bots.qa, browser: true };
    f.deps.bots = { ...f.deps.bots, qa: { ...f.deps.bots.qa, browser: true } };
  }
  f.deps.tasks = createTaskSource({
    bots,
    images: async () => ({
      "claude-api": `registry.example.com/foreman/claude-api${DIGEST}`,
      opencode: `registry.example.com/foreman/opencode${DIGEST}`,
    }),
    secret: async () => MODEL_KEY,
    githubTokens: { mint: async () => GITHUB_TOKEN },
    store: f.store,
  });
  f.deps.runtime = createKubernetesRuntime({ client, settings: SETTINGS });
  return client;
}

/** The started run's handle, as the flow keeps it. */
async function handleOf(f: FlowFixture, nodeId: string): Promise<KubernetesRunHandle> {
  const [run] = await f.store.listRuns({ nodeId });
  return (await f.store.getRunHandle(run?.id ?? "")) as unknown as KubernetesRunHandle;
}

const taskFileOf = (
  client: ReturnType<typeof createFakeKubernetes>,
  h: KubernetesRunHandle,
) =>
  JSON.parse(
    client.get<Secret>("Secret", h.namespace, runNames(h.runId).taskSecret)
      ?.stringData?.["task.json"] ?? "{}",
  ) as { input: string; browser?: true };

const envOf = (job: Job | undefined) =>
  new Map(
    (job?.spec.template.spec.containers[0]?.env ?? []).map((e) => [
      e.name,
      "value" in e ? e.value : undefined,
    ]),
  );

describe("QA's review with the browser (flow: real task source and runtime, ADR 0119 slice 5c)", () => {
  it("gives a site a browser run: the spec, the site Secret, and the browser pod and FOREMAN_BROWSER_URL beside the agent", async () => {
    const f = await createFlowFixture();
    await f.live();
    const client = realRuns(f, true);
    const { node, input } = await qaItem(f);
    f.qaSites.sites.set(`${REPO}#${PREVIEW_RUN}`, {
      found: true,
      zip: ZIP,
      entries: SITE_ENTRIES,
    });
    expect((await dispatch(f.deps, input)).outcome).toBe("started");
    // The site of exactly the preview check's run on the head, read once.
    expect(f.qaSites.reads).toEqual([`${REPO}#${PREVIEW_RUN}`]);
    const handle = await handleOf(f, node.id);
    const n = runNames(handle.runId);
    expect(handle.spec.browser).toBe(true);
    // The handle keeps no byte of the site.
    expect(JSON.stringify(handle)).not.toContain(ZIP_BASE64);
    const site = client.get<Secret>("Secret", handle.namespace, n.siteSecret);
    expect(site?.data).toEqual({ "site.zip": ZIP_BASE64 });
    const file = taskFileOf(client, handle);
    expect(file.browser).toBe(true);
    expect(file.input).not.toContain("No browser");
    expect(JSON.stringify(file)).not.toContain(ZIP_BASE64);
    expect(JSON.stringify(file)).not.toContain("fixture-site-zip");
    // The browser pod comes once the fetch step is done, beside the agent stage.
    expect(client.has("Job", handle.namespace, n.browserJob)).toBe(false);
    client.finishJob(handle.namespace, n.fetchJob, { condition: "Complete" });
    expect(await f.deps.runtime.poll(handle)).toEqual({ state: "running" });
    const browser = client.get<Job>("Job", handle.namespace, n.browserJob);
    expect(browser).toBeDefined();
    const agentEnv = envOf(client.get<Job>("Job", handle.namespace, n.agentJob));
    expect(agentEnv.get("FOREMAN_BROWSER_URL")).toMatch(/^http:\/\/10(\.\d+){3}:8090$/);
    // The browser pod holds no token, model key, task file or proxy setting.
    const browserText = JSON.stringify(browser);
    for (const absent of [
      n.stateTokenSecret,
      n.modelSecret,
      n.taskSecret,
      n.githubTokenSecret,
      "HTTPS_PROXY",
      MODEL_KEY,
      GITHUB_TOKEN,
    ]) {
      expect(browserText).not.toContain(absent);
    }
    expect(browserText).toContain(n.siteSecret);
  });

  it("gives no site the fixed line in QA's input and no browser object, and starts the run as without the browser (D-479)", async () => {
    const f = await createFlowFixture();
    await f.live();
    const client = realRuns(f, true);
    const { node, input } = await qaItem(f);
    // CI kept no qa-site build: the fake read finds none.
    expect((await dispatch(f.deps, input)).outcome).toBe("started");
    expect(f.qaSites.reads).toEqual([`${REPO}#${PREVIEW_RUN}`]);
    const handle = await handleOf(f, node.id);
    expect(handle.spec).not.toHaveProperty("browser");
    const file = taskFileOf(client, handle);
    expect(file).not.toHaveProperty("browser");
    expect(file.input).toContain(
      `## Head commit\n\n${HEAD}\n\n## Browser\n\nNo browser in this run: ${QA_SITE_REASONS.missing}.\n\n# The pull request's change`,
    );
    client.finishJob(handle.namespace, runNames(handle.runId).fetchJob, {
      condition: "Complete",
    });
    await f.deps.runtime.poll(handle);
    expect(
      envOf(
        client.get<Job>("Job", handle.namespace, runNames(handle.runId).agentJob),
      ).has("FOREMAN_BROWSER_URL"),
    ).toBe(false);
    expect(client.calls.filter((c) => /browser|-site\b/.test(c))).toEqual([]);
  });

  it("reads no site for a pull request that changes the site build, and says so", async () => {
    const f = await createFlowFixture();
    await f.live();
    const { input } = await qaItem(f, [
      "src/health.ts",
      ".github/scripts/serve-site.mjs",
    ]);
    f.deps.bots = { ...f.deps.bots, qa: { ...f.deps.bots.qa, browser: true } };
    expect((await dispatch(f.deps, input)).outcome).toBe("started");
    expect(f.qaSites.reads).toEqual([]);
    expect(f.tasksFor[0]?.input).toContain(
      "## Browser\n\nNo browser in this run: the pull request changes the site build or its server.",
    );
    expect(f.tasksFor[0]).not.toHaveProperty("site");
  });

  it("reads no site at all for a bot file that declares no browser, and its input is as before", async () => {
    const f = await createFlowFixture();
    await f.live();
    const { input } = await qaItem(f);
    f.qaSites.sites.set(`${REPO}#${PREVIEW_RUN}`, {
      found: true,
      zip: ZIP,
      entries: SITE_ENTRIES,
    });
    expect((await dispatch(f.deps, input)).outcome).toBe("started");
    expect(f.qaSites.reads).toEqual([]);
    expect(f.tasksFor[0]).not.toHaveProperty("site");
    expect(f.tasksFor[0]?.input).not.toContain("## Browser");
    expect(f.tasksFor[0]?.input).not.toContain("No browser");
  });

  it("starts no QA review when the site cannot be read: nothing is written, as for its change", async () => {
    const f = await createFlowFixture();
    await f.live();
    const { node, input } = await qaItem(f);
    f.deps.bots = { ...f.deps.bots, qa: { ...f.deps.bots.qa, browser: true } };
    const failure = new Error("the runner App's token could not be minted");
    f.deps.qaSites = {
      read: async () => {
        throw failure;
      },
    };
    await expect(dispatch(f.deps, input)).rejects.toBe(failure);
    expect(await f.store.listRuns({ nodeId: node.id })).toEqual([]);
    expect(f.tokens).toEqual([]);
    expect(f.tasksFor).toEqual([]);
    expect(f.runtime.started).toEqual([]);
  });

  it("reads no site for QA's visual comparison or any other role", async () => {
    const f = await createFlowFixture();
    await f.live();
    f.deps.bots = { ...f.deps.bots, qa: { ...f.deps.bots.qa, browser: true } };
    const node = await f.node("ready_for_dev", {
      body: { description: "Add the health check.", checks: ["npm run check"] },
    });
    expect(
      (await dispatch(f.deps, { nodeId: node.id, role: "developer" })).outcome,
    ).toBe("started");
    expect(f.qaSites.reads).toEqual([]);
  });
});
