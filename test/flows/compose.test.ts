// Seam: the flow layer's composition module and its Windmill binding (unit, build plan M3.1,
// ADR 0111 section 4). With a fake environment: which secrets and values are read and when, and
// that every part not built yet refuses with a reason. No database is reached: the pool connects
// on first use and the test never uses it.
import { describe, expect, it } from "vitest";

import { GitHubNotConfiguredError } from "../../src/adapters/github/client.ts";
import { readApprovalReply } from "../../flows/lib/approval.ts";
import { readBotFiles } from "../../src/adapters/contracts-file/bot-files.ts";
import {
  compose,
  NotBuiltError,
  unregisteredRunnerAppTokens,
  unregisteredInstallationTokens,
  type RunToStart,
} from "../../flows/lib/compose.ts";
import {
  SECRET_PATHS,
  VALUE_NAMES,
  type FlowEnvironment,
} from "../../flows/lib/environment.ts";
import {
  windmillEnvironment,
  WindmillNotConfiguredError,
} from "../../flows/lib/windmill.ts";

const DIGEST = `@sha256:${"c".repeat(64)}`;
const IMAGES = JSON.stringify({
  opencode: `registry.example.com/foreman/opencode${DIGEST}`,
  "claude-api": `registry.example.com/foreman/claude-api${DIGEST}`,
});

/** A Council run as the dispatch admits it, on the first routing policy. Fake data only. */
const COUNCIL_START = {
  run: {
    id: "0b6c2f6e-1d2a-4c3b-9a8e-7f6d5c4b3a21",
    bot: "council",
    model: "claude-sonnet-5-5",
    provider: "anthropic",
    serviceTierRequested: "standard",
    modelPrice: {
      tiers: ["standard"],
      pricePerMTok: { standard: { input: 3, cachedInput: 0.3, output: 15 } },
    },
    nodeId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
    headSha: null,
    prNumber: null,
  },
  project: { slug: "rehearsal", repo: "didi-build/rehearsal" },
  input: "Fixture input.",
  branch: null,
  evidenceIds: [],
  capacity: { flexCapacityRetries: 3, maxRejectedModelRequests: 6 },
  stateApiToken: "state-token-value-not-real-0123456789",
  outputSchema: readBotFiles().council.outputSchemas?.escalation,
} as unknown as RunToStart;

function fakeEnvironment(values: Record<string, string> = {}) {
  const secretsRead: string[] = [];
  const env: FlowEnvironment = {
    async secret(path) {
      secretsRead.push(path);
      return "postgresql://runner:not-a-real-password@localhost:1/none";
    },
    async value(name) {
      const all: Record<string, string> = {
        [VALUE_NAMES.specVersion]: "e".repeat(40),
        [VALUE_NAMES.agentImages]: IMAGES,
        [VALUE_NAMES.developerAppLogin]: "foreman-developer[bot]",
        [VALUE_NAMES.designerAppLogin]: "foreman-designer[bot]",
        [VALUE_NAMES.runnerAppSlug]: "foreman-runner",
        ...values,
      };
      const value = all[name];
      if (value === undefined) throw new Error(`${name} is not set`);
      return value;
    },
    async executionsThisMonth() {
      return 42;
    },
  };
  return { env, secretsRead };
}

describe("flow composition (unit: flow layer, build plan M3.1)", () => {
  it("builds the deps from the environment, reading only the database secret up front", async () => {
    const { env, secretsRead } = fakeEnvironment();
    const deps = await compose(env);
    try {
      expect(secretsRead).toEqual([SECRET_PATHS.database]);
      expect(deps.contracts.version).toBe("e".repeat(40));
      expect(deps.appLogins).toEqual([
        "foreman-developer[bot]",
        "foreman-designer[bot]",
      ]);
      expect(deps.runnerAppSlug).toBe("foreman-runner");
      // Runtime, version and limits come from the bot files (contracts/bots/).
      const bots = readBotFiles();
      expect(deps.bots.qa).toEqual({
        runtime: "claude-api",
        botVersion: bots.qa.version,
        outputSchemas: bots.qa.outputSchemas,
      });
      expect(deps.bots.developer.runtime).toBe("opencode");
      expect(deps.bots.council.outputSchemas).toEqual(bots.council.outputSchemas);
      expect(deps.limits.qa).toEqual({ maxTurns: 50, maxMinutes: 20, maxUsd: 2 });
      expect(deps.taskTypes.version).toBe("e".repeat(40));
      expect(deps.taskTypes.roles.developer.default).toBe("developer:code");
      expect(await deps.executionsThisMonth()).toBe(42);
      // Two ids from the real source differ; the clock is the real clock.
      expect(deps.ids.next()).not.toBe(deps.ids.next());
      // Run tokens are long random values in the API's token pattern, never the same twice.
      const [one, two] = [deps.newRunToken(), deps.newRunToken()];
      expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(one === two).toBe(false);
    } finally {
      await deps.close();
    }
  });

  it("refuses every part that is not built yet, with what it waits on", async () => {
    const { env } = fakeEnvironment();
    const deps = await compose(env);
    try {
      await expect(deps.github.listOpenPullRequests("didi-build/x")).rejects.toThrow(
        GitHubNotConfiguredError,
      );
      // The GitHub installation tokens wait on the role's GitHub App (D-178).
      await expect(
        unregisteredInstallationTokens().mint({
          role: "developer",
          repository: "didi-build/x",
          access: "write",
          runId: "r",
        }),
      ).rejects.toThrow(NotBuiltError);
      await expect(
        deps.github.listDeployments("didi-build/x", "staging", "b".repeat(40)),
      ).rejects.toThrow(GitHubNotConfiguredError);
      await expect(
        deps.github.compareCommits("didi-build/x", "b".repeat(40), "c".repeat(40)),
      ).rejects.toThrow(GitHubNotConfiguredError);
      await expect(deps.stagingChecker.check({} as never)).rejects.toThrow(
        /deploy adapter's staging target/,
      );
      // The repo map and the screenshot bundles wait on the runner App's read tokens (D-267).
      // The repo map's Job (D-275 (2)) refuses on the token, before the cluster is read.
      const project = { slug: "x", repo: "didi-build/x" };
      await expect(deps.repoMaps.read(project, "b".repeat(40))).rejects.toThrow(
        NotBuiltError,
      );
      await expect(deps.repoMaps.read(project)).rejects.toThrow(/runner App/);
      // The Scanner's stage 1 uses the same Job in scan mode, so it refuses the same way (O-92).
      await expect(deps.repoScans.scan(project)).rejects.toThrow(NotBuiltError);
      await expect(
        deps.screenshots.read("didi-build/x", "b".repeat(40), "gallery"),
      ).rejects.toThrow(NotBuiltError);
      await expect(
        deps.repoFolders.folderId(
          "didi-build/x",
          "b".repeat(40),
          "design/a/b/options/c",
        ),
      ).rejects.toThrow(NotBuiltError);
      await expect(
        unregisteredRunnerAppTokens().mint({
          repository: "didi-build/x",
          permission: "contents",
        }),
      ).rejects.toThrow(/contents read and actions read/);
    } finally {
      await deps.close();
    }
  });

  it("builds a Council task from its bot file, reading its model key by path and the images once", async () => {
    const { env, secretsRead } = fakeEnvironment();
    const deps = await compose(env);
    try {
      const task = (await deps.tasks.taskFor(COUNCIL_START)) as {
        image: string;
        providers: { secretPath?: string }[];
        credentials: { models: Record<string, string>; githubToken?: string };
        task: { instructions: string; outputSchema?: unknown };
      };
      expect(task.image).toBe(`registry.example.com/foreman/claude-api${DIGEST}`);
      expect(task.providers.map((p) => p.secretPath)).toEqual([
        "projects/rehearsal/models/anthropic",
      ]);
      expect(Object.keys(task.credentials.models)).toEqual([
        "projects/rehearsal/models/anthropic",
      ]);
      expect(task.credentials.githubToken).toBeUndefined();
      expect(task.task.instructions).toBe(readBotFiles().council.instructions);
      expect(task.task.outputSchema).toEqual(COUNCIL_START.outputSchema);
      expect(secretsRead).toEqual([
        SECRET_PATHS.database,
        "projects/rehearsal/models/anthropic",
      ]);
    } finally {
      await deps.close();
    }
  });

  it("reads the cluster token only when an agent is started or polled", async () => {
    const { env, secretsRead } = fakeEnvironment({
      [VALUE_NAMES.clusterEndpoint]: "https://cluster.example.test",
      [VALUE_NAMES.clusterCaCertificate]: "not a certificate",
      [VALUE_NAMES.agentRunSettings]: "{}",
    });
    const deps = await compose(env);
    try {
      // The fake settings are incomplete, so building the runtime fails after the read.
      await expect(deps.runtime.poll({})).rejects.toThrow();
      expect(secretsRead).toEqual([SECRET_PATHS.database, SECRET_PATHS.clusterToken]);
    } finally {
      await deps.close();
    }
  });

  it("names a bad agent images value, never its content", async () => {
    for (const raw of ["{secret-ish", JSON.stringify(["not", "an", "object"])]) {
      const { env } = fakeEnvironment({ [VALUE_NAMES.agentImages]: raw });
      const deps = await compose(env);
      try {
        await expect(deps.tasks.taskFor(COUNCIL_START)).rejects.toThrow(
          /^agent_images (is not valid JSON|must be an object of image references)$/,
        );
      } finally {
        await deps.close();
      }
    }
  });

  it("has a Windmill binding that refuses until the workspace and token exist", async () => {
    const env = windmillEnvironment();
    await expect(env.secret(SECRET_PATHS.database)).rejects.toThrow(
      WindmillNotConfiguredError,
    );
    await expect(env.value(VALUE_NAMES.specVersion)).rejects.toThrow(
      WindmillNotConfiguredError,
    );
    await expect(env.executionsThisMonth()).rejects.toThrow(WindmillNotConfiguredError);
  });
});

describe("approval page reply (unit: flow layer, M0.4, D-200, D-254)", () => {
  it.each([
    ["Approve", "approve"],
    ["Request changes", "changes_requested"],
    ["Reject", "reject"],
  ] as const)(
    "reads the form's %s with its options and Didi's feedback exactly as typed",
    (label, choice) => {
      expect(
        readApprovalReply(
          { decision: label, options: ["a", "b"], feedback: " as typed " },
          ["anonymous", 3],
        ),
      ).toEqual({
        answered: true,
        choice,
        words: " as typed ",
        approvers: ["anonymous"],
        options: ["a", "b"],
      });
    },
  );

  it("reads Didi's optional size call on a visual approval, and leaves it out when skipped (D-278)", () => {
    expect(
      readApprovalReply({ decision: "Approve", small_tweak: "Yes, a small tweak" }, []),
    ).toMatchObject({ answered: true, smallTweak: true });
    expect(
      readApprovalReply(
        { decision: "Reject", feedback: "No.", small_tweak: "No, not a small tweak" },
        [],
      ),
    ).toMatchObject({ answered: true, smallTweak: false });
    expect(readApprovalReply({ decision: "Approve" }, [])).not.toHaveProperty(
      "smallTweak",
    );
    expect(
      readApprovalReply({ decision: "Approve", small_tweak: "maybe" }, []),
    ).not.toHaveProperty("smallTweak");
  });

  it("reads a form with no options or no feedback, and refuses options that are not names", () => {
    expect(readApprovalReply({ decision: "Approve" }, [])).toEqual({
      answered: true,
      choice: "approve",
      words: null,
      approvers: [],
      options: [],
    });
    expect(
      readApprovalReply({ decision: "Approve", options: "a", feedback: "x" }, []),
    ).toMatchObject({ answered: false, reason: "bad_options", replyVerbatim: "x" });
    expect(readApprovalReply({ decision: "Approve", options: [3] }, [])).toMatchObject({
      answered: false,
      reason: "bad_options",
    });
    // The older form's label is not one of the Decision field's.
    expect(
      readApprovalReply({ decision: "Changes requested", feedback: "x" }, []),
    ).toMatchObject({ answered: false, reason: "no_choice" });
  });

  it.each([
    ["Approve", "approve"],
    ["Reject", "reject"],
    ["Changes requested", "changes_requested"],
  ] as const)(
    "still reads the older form's %s for a request opened before D-254",
    (label, choice) => {
      expect(
        readApprovalReply({ answer: label, reply: " as typed " }, ["anonymous", 3]),
      ).toEqual({
        answered: true,
        choice,
        words: " as typed ",
        approvers: ["anonymous"],
        options: [],
      });
    },
  );

  it("reads the older form's option name as its one option (D-242, O-66)", () => {
    expect(
      readApprovalReply({ answer: "Approve", reply: "a", option: "a" }, ["anonymous"]),
    ).toMatchObject({ answered: true, options: ["a"] });
    expect(
      readApprovalReply({ answer: "Approve", reply: "a", option: 3 }, []),
    ).toMatchObject({ answered: true, options: [] });
  });

  it("reads a timeout, and a form with no known answer, as no answer, keeping any words", () => {
    expect(readApprovalReply({ error: { name: "timeout" } }, null)).toEqual({
      answered: false,
      reason: "timeout",
      replyVerbatim: null,
      approvers: [],
    });
    expect(readApprovalReply({ reply: "yes" }, [])).toEqual({
      answered: false,
      reason: "no_choice",
      replyVerbatim: "yes",
      approvers: [],
    });
    expect(readApprovalReply({ answer: "toString", reply: "x" }, [])).toMatchObject({
      answered: false,
      reason: "no_choice",
    });
    expect(readApprovalReply(null, [])).toMatchObject({ answered: false });
  });
});
