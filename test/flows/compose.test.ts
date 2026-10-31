// Seam: the flow layer's composition module and its Windmill binding (unit, build plan M3.1,
// ADR 0111 section 4). With a fake environment: which secrets and values are read and when, and
// that every part not built yet refuses with a reason. No database is reached: the pool connects
// on first use and the test never uses it.
import { describe, expect, it } from "vitest";

import { GitHubNotConfiguredError } from "../../src/adapters/github/client.ts";
import { readApprovalReply } from "../../flows/lib/approval.ts";
import { compose, NotBuiltError, parseBotProfiles } from "../../flows/lib/compose.ts";
import {
  SECRET_PATHS,
  VALUE_NAMES,
  type FlowEnvironment,
} from "../../flows/lib/environment.ts";
import {
  windmillEnvironment,
  WindmillNotConfiguredError,
} from "../../flows/lib/windmill.ts";

const PROFILE = { runtime: "kubernetes", botVersion: "v1" };
const BOTS = JSON.stringify({
  developer: PROFILE,
  designer: PROFILE,
  qa: { ...PROFILE, botVersion: "v2" },
  council: PROFILE,
  triage: PROFILE,
});

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
        [VALUE_NAMES.botProfiles]: BOTS,
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
      expect(deps.bots.qa.botVersion).toBe("v2");
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
      await expect(deps.tasks.taskFor({} as never)).rejects.toThrow(NotBuiltError);
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

  it("names a bad bot profile value, never its content", () => {
    expect(() => parseBotProfiles("{secret-ish")).toThrow(
      new Error("bot_profiles is not valid JSON"),
    );
    expect(() =>
      parseBotProfiles(JSON.stringify({ developer: { model: "m-123" } })),
    ).toThrow(new Error("bot_profiles has no complete profile for developer"));
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

describe("approval page reply (unit: flow layer, M0.4, D-200)", () => {
  it.each([
    ["Approve", "approve"],
    ["Reject", "reject"],
    ["Changes requested", "changes_requested"],
  ] as const)("reads %s with Didi's words exactly as typed", (label, choice) => {
    expect(
      readApprovalReply({ answer: label, reply: " as typed " }, ["anonymous", 3]),
    ).toEqual({
      answered: true,
      choice,
      words: " as typed ",
      approvers: ["anonymous"],
    });
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
