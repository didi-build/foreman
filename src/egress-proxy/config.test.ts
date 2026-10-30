import { describe, expect, it } from "vitest";

import { ConfigError, secretEnvName } from "../service-kit/config.ts";
import { readProxyConfig } from "./config.ts";

const SECRET_PATH = "projects/rehearsal/models/anthropic";
const KEY_VALUE = "sk-test-not-a-real-key-123456";

const goodEnv = {
  RUN_ID: "run_123",
  ALLOWED_HOSTS: "github.com,api.github.com",
  MODEL_PROVIDERS: JSON.stringify([
    {
      name: "anthropic",
      upstream: "https://api.anthropic.com",
      credential: "x-api-key",
      secretPath: SECRET_PATH,
    },
  ]),
  MAX_MODEL_REQUESTS: "200",
  [secretEnvName(SECRET_PATH)]: KEY_VALUE,
};

function problems(env: Record<string, string | undefined>): string[] {
  try {
    readProxyConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

describe("readProxyConfig (unit: egress proxy settings, ADR 0111)", () => {
  it("reads every setting and each provider's credential by its secret path", () => {
    const config = readProxyConfig(goodEnv);
    expect(config.port).toBe(8080);
    expect(config.runId).toBe("run_123");
    expect([...config.allowedHosts]).toEqual(["github.com", "api.github.com"]);
    expect(config.providers.map((p) => p.name)).toEqual(["anthropic"]);
    expect(config.maxModelRequests).toBe(200);
    expect(config.credentials.get("anthropic")).toBe(KEY_VALUE);
  });

  it("names a missing provider secret by its variable, never a value", () => {
    const found = problems({ ...goodEnv, [secretEnvName(SECRET_PATH)]: undefined });
    expect(found).toEqual([`${secretEnvName(SECRET_PATH)} is not set`]);
  });

  it.each([
    ["RUN_ID", "run id with spaces"],
    ["ALLOWED_HOSTS", "10.0.0.1"],
    ["MODEL_PROVIDERS", `[{"name":"x","upstream":"${KEY_VALUE}"}]`],
    ["MAX_MODEL_REQUESTS", "0"],
    ["MAX_MODEL_REQUESTS", "1.5"],
    ["MAX_MODEL_REQUESTS", "-3"],
  ])("stops on a bad %s, naming it but not its value", (name, value) => {
    const found = problems({ ...goodEnv, [name]: value });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(new RegExp(`^${name} `));
    expect(found.join(" ")).not.toContain(value);
  });
});
