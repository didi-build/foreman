import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  envExposesBootstrapToken,
  envWithoutBootstrapTokens,
} from "../scripts/lib/bootstrap-token-env.mjs";

describe("bootstrap token env (unit)", () => {
  it("envWithoutBootstrapTokens removes GH_TOKEN, BOOTSTRAP_TOKEN, and GITHUB_TOKEN", () => {
    const stripped = envWithoutBootstrapTokens({
      PATH: "/bin",
      GH_TOKEN: "a",
      BOOTSTRAP_TOKEN: "b",
      GITHUB_TOKEN: "c",
      LAUNCHPAD_COLLECTS_PERSONAL_DATA: "true",
    });
    expect(envExposesBootstrapToken(stripped)).toBe(false);
    expect(stripped.LAUNCHPAD_COLLECTS_PERSONAL_DATA).toBe("true");
  });

  it("npm ci child process does not inherit bootstrap tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-npm-env-"));
    writeFileSync(join(dir, "package.json"), '{"name":"probe"}\n');
    const childEnv = envWithoutBootstrapTokens({
      ...process.env,
      BOOTSTRAP_TOKEN: "probe-token",
      GH_TOKEN: "probe-token",
    });
    const probe = spawnSync(
      process.execPath,
      ["-e", "process.exit(process.env.BOOTSTRAP_TOKEN ? 1 : 0)"],
      { env: childEnv, encoding: "utf8" },
    );
    expect(probe.status).toBe(0);
  });

  it("init-project child env matches bootstrap init stripping", () => {
    const childEnv = envWithoutBootstrapTokens({
      ...process.env,
      BOOTSTRAP_TOKEN: "probe-token",
    });
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        "process.exit(process.env.BOOTSTRAP_TOKEN || process.env.GH_TOKEN ? 1 : 0)",
      ],
      { env: childEnv, encoding: "utf8" },
    );
    expect(probe.status).toBe(0);
  });

  it("repo-settings child env keeps only GH_TOKEN from extra env", () => {
    const childEnv: NodeJS.ProcessEnv = {
      ...envWithoutBootstrapTokens({
        PATH: "/bin",
        BOOTSTRAP_TOKEN: "bootstrap",
        GITHUB_TOKEN: "actions",
        GH_TOKEN: "stale",
      }),
      GH_TOKEN: "for-gh-cli",
    };
    expect(childEnv.GH_TOKEN).toBe("for-gh-cli");
    expect(childEnv.BOOTSTRAP_TOKEN).toBeUndefined();
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();
  });
});
