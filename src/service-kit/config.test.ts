import { describe, expect, it } from "vitest";
import {
  ConfigError,
  port,
  readConfig,
  secret,
  secretEnvName,
  text,
} from "./config.ts";

describe("readConfig (unit: service kit, ADR 0111)", () => {
  it("reads values from the environment and uses fallbacks for unset ones", () => {
    const config = readConfig(
      { port: port("PORT", "8080"), name: text("NAME") },
      { NAME: "svc" },
    );
    expect(config).toEqual({ port: 8080, name: "svc" });
  });

  it("prefers the environment over the fallback", () => {
    expect(readConfig({ port: port("PORT", "8080") }, { PORT: "9090" }).port).toBe(
      9090,
    );
  });

  it("collects every problem before failing", () => {
    const attempt = () =>
      readConfig({ port: port("PORT"), name: text("NAME") }, { PORT: "70000" });
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      expect((error as ConfigError).problems).toEqual([
        "PORT is not a port number between 1 and 65535",
        "NAME is not set",
      ]);
    }
  });

  it("never puts the rejected value in the error", () => {
    const value = "sk-looks-like-a-secret-123456";
    try {
      readConfig({ port: port("PORT") }, { PORT: value });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });

  it.each(["0", "1.5", "abc", ""])("rejects port value %j", (raw) => {
    expect(() => readConfig({ port: port("PORT") }, { PORT: raw })).toThrow(
      ConfigError,
    );
  });

  it("rejects a blank text setting", () => {
    expect(() => readConfig({ name: text("NAME") }, { NAME: "  " })).toThrow(
      "NAME is empty",
    );
  });
});

describe("secrets by path (unit: service kit, ADR 0111 section 4)", () => {
  it("maps a secret path to one environment variable", () => {
    expect(secretEnvName("platform/github/runner-webhook-secret")).toBe(
      "SECRET_PLATFORM_GITHUB_RUNNER_WEBHOOK_SECRET",
    );
  });

  it("reads the secret, and names only the variable when it is missing", () => {
    const path = "platform/github/runner-webhook-secret";
    expect(
      readConfig({ key: secret(path) }, { [secretEnvName(path)]: "test-only-value" }),
    ).toEqual({ key: "test-only-value" });
    expect(() => readConfig({ key: secret(path) }, {})).toThrow(
      "SECRET_PLATFORM_GITHUB_RUNNER_WEBHOOK_SECRET is not set",
    );
  });
});
