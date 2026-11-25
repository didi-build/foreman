// Seam: unit. The task `start` takes, built from an admitted run (ADR 0106 section 5, ADR 0107,
// ADR 0114 section 5): the route's model, only the route's provider and only its credential, the
// credentials each role holds, and a task that `start` accepts. QA's review with a site gets the
// browser (ADR 0119 slice 5c). Fake values only.
import { describe, expect, it } from "vitest";

import { buildKubernetesTask, type KubernetesTaskParts } from "./build-task.ts";
import { createFakeKubernetes } from "./fake.ts";
import {
  DEVELOPER,
  GITHUB_TOKEN,
  LIMITS,
  MODEL_KEY,
  MODEL_SECRET_PATH,
  QA,
  QA_LIMITS,
  SETTINGS,
  SITE_ZIP,
  STATE_TOKEN,
} from "./fixtures.ts";
import { runNames } from "./names.ts";
import type { Job, Secret } from "./objects.ts";
import { createKubernetesRuntime } from "./runtime.ts";
import { firstRunPrice } from "../../../core/routing-testing.ts";

const OTHER_PATH = "projects/rehearsal/models/deepinfra";
const OTHER_KEY = "other-model-key-value-not-real-0123";

function parts(extra: Partial<KubernetesTaskParts> = {}): KubernetesTaskParts {
  return {
    run: {
      id: DEVELOPER.runId,
      bot: "developer",
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      serviceTierRequested: "standard",
      modelPrice: firstRunPrice("claude-sonnet-5-5"),
      nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
      headSha: null,
      prNumber: null,
      taskType: "developer:code",
    },
    projectSlug: "rehearsal",
    repository: "didi-build/rehearsal",
    bot: {
      image: DEVELOPER.image,
      instructions: "Fixture instructions.",
      allowedTools: ["Read", "Edit"],
      allowedHosts: DEVELOPER.allowedHosts,
    },
    providers: [
      ...DEVELOPER.providers,
      {
        name: "deepinfra",
        upstream: "https://api.deepinfra.com",
        credential: "bearer",
        secretPath: OTHER_PATH,
      },
    ],
    input: "Fixture input.",
    capacity: { flexCapacityRetries: 3, maxRejectedModelRequests: 6 },
    stateApiToken: STATE_TOKEN,
    githubToken: GITHUB_TOKEN,
    modelCredentials: { [MODEL_SECRET_PATH]: MODEL_KEY, [OTHER_PATH]: OTHER_KEY },
    ...extra,
  };
}

describe("the task built from a run (unit, ADR 0114 section 5)", () => {
  it("names the route's model and gives the proxy only the route's provider and credential", () => {
    const task = buildKubernetesTask(parts());
    expect(task.model).toBe("claude-sonnet-5-5");
    expect(task.providers.map((p) => p.name)).toEqual(["anthropic"]);
    expect(task.credentials).toEqual({
      stateApiToken: STATE_TOKEN,
      githubToken: GITHUB_TOKEN,
      models: { [MODEL_SECRET_PATH]: MODEL_KEY },
    });
    expect(JSON.stringify(task)).not.toContain(OTHER_KEY);
    expect(task.task).toEqual({
      foremanTask: 1,
      instructions: "Fixture instructions.",
      input: "Fixture input.",
      allowedTools: ["Read", "Edit"],
      // The wrapper opens the PR on this branch and posts the docs note for this node (N-44).
      nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
      branch: "foreman/1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
    });
  });

  it("refuses a Developer run without its node, which the PR and docs note need (N-44)", () => {
    const run = { ...parts().run, nodeId: null };
    expect(() => buildKubernetesTask(parts({ run }))).toThrow(
      "a developer run needs its node",
    );
  });

  it("carries the route's tier and the Flex capacity bounds into the run (ADR 0114 sections 8 and 9)", () => {
    const run = { ...parts().run, serviceTierRequested: "flex" as const };
    const task = buildKubernetesTask(
      parts({ run, capacity: { flexCapacityRetries: 2, maxRejectedModelRequests: 4 } }),
    );
    expect(task).toMatchObject({
      serviceTier: "flex",
      flexCapacityRetries: 2,
      maxRejectedModelRequests: 4,
    });
  });

  it("passes the price recorded on the run, and refuses a run without one (ADR 0114 section 5)", () => {
    const task = buildKubernetesTask(parts());
    expect(task.price).toEqual(firstRunPrice("claude-sonnet-5-5"));
    const run = { ...parts().run, modelPrice: null };
    expect(() => buildKubernetesTask(parts({ run }))).toThrow(
      "the run has no recorded price",
    );
  });

  it("marks a close run's task with the close-only mode and nothing else (D-318)", () => {
    const base = parts();
    const task = buildKubernetesTask(
      parts({ run: { ...base.run, taskType: "developer:close", prNumber: 7 } }),
    );
    expect(task.task.mode).toBe("close_pull_request");
    expect(task.task.branch).toBe("foreman/1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b");
    expect(buildKubernetesTask(parts()).task.mode).toBeUndefined();
  });

  it("passes the bot file's context tools into the task, never into a close run's (ADR 0119 slice 3c)", () => {
    const base = parts();
    const withTools = parts({
      bot: { ...base.bot, contextTools: ["search_decisions", "find_similar_items"] },
    });
    expect(buildKubernetesTask(withTools).task.contextTools).toEqual([
      "search_decisions",
      "find_similar_items",
    ]);
    expect(buildKubernetesTask(parts()).task).not.toHaveProperty("contextTools");
    const close = buildKubernetesTask({
      ...withTools,
      run: { ...base.run, taskType: "developer:close", prNumber: 7 },
    });
    expect(close.task.mode).toBe("close_pull_request");
    expect(close.task).not.toHaveProperty("contextTools");
  });

  it("passes the given docs lookup hosts into the task and the run's proxy, never into a close run's or one with images (ADR 0119 slices 4b and 4c)", () => {
    const base = parts();
    const hosts = ["developer.mozilla.org", "vitest.dev"];
    const withHosts = parts({ bot: { ...base.bot, docsLookupHosts: hosts } });
    const built = buildKubernetesTask(withHosts);
    expect(built.task.docsLookupHosts).toEqual(hosts);
    // The proxy's lookup route gets exactly the hosts the tool lists (slice 4a's field).
    expect(built.lookupHosts).toEqual(hosts);
    expect(buildKubernetesTask(parts()).task).not.toHaveProperty("docsLookupHosts");
    expect(buildKubernetesTask(parts())).not.toHaveProperty("lookupHosts");
    const empty = buildKubernetesTask(
      parts({ bot: { ...base.bot, docsLookupHosts: [] } }),
    );
    expect(empty.task).not.toHaveProperty("docsLookupHosts");
    expect(empty).not.toHaveProperty("lookupHosts");
    const close = buildKubernetesTask({
      ...withHosts,
      run: { ...base.run, taskType: "developer:close", prNumber: 7 },
    });
    expect(close.task.mode).toBe("close_pull_request");
    expect(close.task).not.toHaveProperty("docsLookupHosts");
    expect(close).not.toHaveProperty("lookupHosts");
    const visual = buildKubernetesTask({
      ...withHosts,
      run: { ...base.run, bot: "qa", taskType: "qa:visual", headSha: "a".repeat(40) },
      bot: { ...withHosts.bot, allowedTools: undefined, allowedHosts: [] },
      images: [{ label: "Image 1", mediaType: "image/png", data: "iVBORw0KGgo=" }],
    });
    expect(visual.task.images).toHaveLength(1);
    expect(visual.task).not.toHaveProperty("docsLookupHosts");
    expect(visual).not.toHaveProperty("lookupHosts");
  });

  it("refuses a run whose provider has no provider setting", () => {
    const others = parts().providers.filter((p) => p.name !== "anthropic");
    expect(() => buildKubernetesTask(parts({ providers: others }))).toThrow(
      "the run's provider needs exactly one provider setting",
    );
  });

  it("builds a QA task with its head, pull request, node and evidence ids", () => {
    const task = buildKubernetesTask(
      parts({
        run: {
          id: QA.runId,
          bot: "qa",
          model: "claude-opus-5-5",
          provider: "anthropic",
          serviceTierRequested: "standard",
          modelPrice: firstRunPrice("claude-opus-5-5"),
          nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
          headSha: QA.headSha ?? null,
          prNumber: QA.prNumber ?? null,
          taskType: "qa:review",
        },
        bot: {
          image: QA.image,
          instructions: "Fixture instructions.",
          allowedHosts: [],
          fetchAllowedHosts: QA.fetchAllowedHosts,
        },
        evidenceIds: ["2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d"],
      }),
    );
    expect(task).toMatchObject({
      role: "qa",
      headSha: QA.headSha,
      prNumber: QA.prNumber,
      fetchAllowedHosts: QA.fetchAllowedHosts,
      task: {
        nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
        evidenceIds: ["2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d"],
      },
    });
  });

  it("gives a task the Kubernetes runtime starts, for the Developer and for QA", async () => {
    const client = createFakeKubernetes();
    const runtime = createKubernetesRuntime({ client, settings: SETTINGS });
    const handle = await runtime.start(buildKubernetesTask(parts()), LIMITS);
    expect(handle.spec.providers.map((p) => p.name)).toEqual(["anthropic"]);
    expect(JSON.stringify(handle)).not.toContain(STATE_TOKEN);
    const qa = buildKubernetesTask(
      parts({
        run: {
          id: QA.runId,
          bot: "qa",
          model: "claude-opus-5-5",
          provider: "anthropic",
          serviceTierRequested: "standard",
          modelPrice: firstRunPrice("claude-opus-5-5"),
          nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
          headSha: QA.headSha ?? null,
          prNumber: QA.prNumber ?? null,
          taskType: "qa:review",
        },
        bot: {
          image: QA.image,
          instructions: "Fixture instructions.",
          allowedHosts: [],
          fetchAllowedHosts: QA.fetchAllowedHosts,
        },
      }),
    );
    await expect(runtime.start(qa, QA_LIMITS)).resolves.toMatchObject({
      runId: QA.runId,
    });
  });

  it("starts a Developer task with docs lookup hosts with its proxy's lookup route on those hosts, and refuses one for QA (ADR 0119 slice 4c, ADR 0106 section 3)", async () => {
    const client = createFakeKubernetes();
    const runtime = createKubernetesRuntime({ client, settings: SETTINGS });
    const hosts = ["developer.mozilla.org", "vitest.dev"];
    const base = parts();
    const task = buildKubernetesTask(
      parts({ bot: { ...base.bot, docsLookupHosts: hosts } }),
    );
    const handle = await runtime.start(task, LIMITS);
    expect(handle.spec.lookupHosts).toEqual(hosts);
    const env = [...client.objects.values()]
      .filter((o) => o.kind === "Job")
      .flatMap((job) =>
        (
          job as {
            spec: { template: { spec: { containers: { env?: unknown[] }[] } } };
          }
        ).spec.template.spec.containers.flatMap((c) => c.env ?? []),
      ) as { name: string; value?: string }[];
    expect(env.find((e) => e.name === "LOOKUP_HOSTS")?.value).toBe(hosts.join(","));
    expect(env.find((e) => e.name === "FOREMAN_LOOKUP_URL")?.value).toMatch(
      /\/lookup$/,
    );
    // QA reaches nothing outside its providers and the state API (ADR 0106 section 3, D-471).
    const qa = buildKubernetesTask(
      parts({
        run: {
          id: QA.runId,
          bot: "qa",
          model: "claude-opus-5-5",
          provider: "anthropic",
          serviceTierRequested: "standard",
          modelPrice: firstRunPrice("claude-opus-5-5"),
          nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
          headSha: QA.headSha ?? null,
          prNumber: QA.prNumber ?? null,
          taskType: "qa:review",
        },
        bot: {
          image: QA.image,
          instructions: "Fixture instructions.",
          allowedHosts: [],
          fetchAllowedHosts: QA.fetchAllowedHosts,
          docsLookupHosts: hosts,
        },
      }),
    );
    expect(qa.lookupHosts).toEqual(hosts);
    await expect(runtime.start(qa, QA_LIMITS)).rejects.toThrow(
      "a qa run has no documentation lookup",
    );
  });

  describe("QA's review with a site (ADR 0119 slice 5c, D-476)", () => {
    const qaRun = (taskType = "qa:review") => ({
      id: QA.runId,
      bot: "qa" as const,
      model: "claude-opus-5-5",
      provider: "anthropic",
      serviceTierRequested: "standard" as const,
      modelPrice: firstRunPrice("claude-opus-5-5"),
      nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
      headSha: QA.headSha ?? null,
      prNumber: QA.prNumber ?? null,
      taskType,
    });
    const qaBot = {
      image: QA.image,
      instructions: "Fixture instructions.",
      allowedHosts: [],
      fetchAllowedHosts: QA.fetchAllowedHosts,
    };

    it("gives the run's spec and its task file the browser, and the zip to start only", () => {
      const task = buildKubernetesTask(
        parts({ run: qaRun(), bot: qaBot, site: SITE_ZIP }),
      );
      expect(task.browser).toBe(true);
      expect(task.task.browser).toBe(true);
      expect(task.site).toBe(SITE_ZIP);
      // The site is never in the task file, and the task file never in the spec.
      const zip = Buffer.from(SITE_ZIP).toString("base64");
      expect(JSON.stringify(task.task)).not.toContain(zip);
      expect(JSON.stringify(task.task)).not.toContain("fixture-site-zip");
      // Without a site, a QA review has no browser, as before.
      const plain = buildKubernetesTask(parts({ run: qaRun(), bot: qaBot }));
      expect(plain).not.toHaveProperty("browser");
      expect(plain.task).not.toHaveProperty("browser");
      expect(plain).not.toHaveProperty("site");
    });

    it("refuses a site for any other role and for QA's visual comparison", () => {
      expect(() => buildKubernetesTask(parts({ site: SITE_ZIP }))).toThrow(
        "only QA's review (qa:review) runs a browser",
      );
      expect(() =>
        buildKubernetesTask(
          parts({
            run: qaRun("qa:visual"),
            bot: { ...qaBot, outputSchema: { type: "object" } },
            images: [{ label: "Image 1", mediaType: "image/png", data: "iVBORw==" }],
            site: SITE_ZIP,
          }),
        ),
      ).toThrow("only QA's review (qa:review) runs a browser");
    });

    it("starts a browser run: the site Secret at the start, then the browser pod and FOREMAN_BROWSER_URL beside the agent", async () => {
      const client = createFakeKubernetes();
      const runtime = createKubernetesRuntime({ client, settings: SETTINGS });
      const task = buildKubernetesTask(
        parts({ run: qaRun(), bot: qaBot, site: SITE_ZIP }),
      );
      const handle = await runtime.start(task, QA_LIMITS);
      const n = runNames(QA.runId);
      const ns = handle.namespace;
      expect(handle.spec.browser).toBe(true);
      const site = client.get<Secret>("Secret", ns, n.siteSecret);
      expect(Buffer.from(site?.data?.["site.zip"] ?? "", "base64")).toEqual(
        Buffer.from(SITE_ZIP),
      );
      const file = client.get<Secret>("Secret", ns, n.taskSecret);
      expect(JSON.parse(file?.stringData?.["task.json"] ?? "{}")).toMatchObject({
        browser: true,
      });
      client.finishJob(ns, n.fetchJob, { condition: "Complete" });
      await runtime.poll(handle);
      const agent = client.get<Job>("Job", ns, n.agentJob);
      const env = agent?.spec.template.spec.containers[0]?.env ?? [];
      expect(env.find((e) => e.name === "FOREMAN_BROWSER_URL")).toMatchObject({
        value: expect.stringMatching(/^http:\/\/10\.\d+\.\d+\.\d+:8090$/),
      });
      // The token never reaches the browser pod.
      const browser = client.get<Job>("Job", ns, n.browserJob);
      expect(browser).toBeDefined();
      expect(JSON.stringify(browser)).not.toContain(n.stateTokenSecret);
      expect(JSON.stringify(browser)).not.toContain(STATE_TOKEN);
      expect(JSON.stringify(browser)).not.toContain(n.taskSecret);
    });
  });
});
