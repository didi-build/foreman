// Seam: unit. The task `start` takes, built from an admitted run (ADR 0106 section 5, ADR 0107,
// ADR 0114 section 5): the route's model, only the route's provider and only its credential, the
// credentials each role holds, and a task that `start` accepts. Fake values only.
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
  STATE_TOKEN,
} from "./fixtures.ts";
import { createKubernetesRuntime } from "./runtime.ts";

const OTHER_PATH = "projects/rehearsal/models/deepinfra";
const OTHER_KEY = "other-model-key-value-not-real-0123";

function parts(extra: Partial<KubernetesTaskParts> = {}): KubernetesTaskParts {
  return {
    run: {
      id: DEVELOPER.runId,
      bot: "developer",
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
      headSha: null,
      prNumber: null,
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
    });
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
          nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
          headSha: QA.headSha ?? null,
          prNumber: QA.prNumber ?? null,
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
          nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
          headSha: QA.headSha ?? null,
          prNumber: QA.prNumber ?? null,
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
});
