import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  allowListedEnv,
  MISSING_SETTING_EXIT,
  quoteWindowsArgument,
  redact,
  truncate,
} from "./spike.ts";

describe("spike helpers (unit: spike tooling)", () => {
  it("redacts every occurrence of a secret", () => {
    expect(redact("a sk-test-123456 b sk-test-123456", ["sk-test-123456"])).toBe(
      "a [redacted] b [redacted]",
    );
  });

  it("does not redact very short values, which would mangle ordinary text", () => {
    expect(redact("abc abc", ["abc"])).toBe("abc abc");
  });

  it("truncates long text and says how much was cut", () => {
    expect(truncate("x".repeat(10), 4)).toBe("xxxx\n[truncated 6 characters]");
  });
});

describe("spike scripts without credentials (integration: process boundary)", () => {
  const secret = "test-secret-value-must-not-print";
  const run = spawnSync(
    process.execPath,
    ["spikes/m0.2-agent-dispatch/qa-verdict.ts"],
    {
      env: { PATH: process.env.PATH, QA_API_KEY: secret },
      encoding: "utf8",
    },
  );

  it("stops with the missing-setting exit code before calling anything", () => {
    expect(run.status).toBe(MISSING_SETTING_EXIT);
  });

  it("names the missing settings", () => {
    expect(run.stderr).toContain("QA_BASE_URL");
    expect(run.stderr).toContain("QA_MODEL");
  });

  it("never prints a credential value", () => {
    expect(run.stdout + run.stderr).not.toContain(secret);
  });
});

describe("quoteWindowsArgument (unit: spike tooling)", () => {
  it("keeps text with spaces and quotes as one argument", () => {
    expect(quoteWindowsArgument('Create a file "X.md" now')).toBe(
      '"Create a file \\"X.md\\" now"',
    );
  });

  it("doubles backslashes that come before a quote or the end", () => {
    expect(quoteWindowsArgument("C:\\dir\\")).toBe('"C:\\dir\\\\"');
  });

  it.each(["50%", "a & b", "a | b", "a > b", "^", "a!b", "line\nbreak"])(
    "refuses %j, which cmd.exe would interpret",
    (argument) => {
      expect(() => quoteWindowsArgument(argument)).toThrow();
    },
  );
});

describe("allowListedEnv (unit: spike tooling)", () => {
  it("passes only the listed variables that are set", () => {
    expect(
      allowListedEnv(["PATH", "KEY", "MISSING"], {
        PATH: "/bin",
        KEY: "k",
        OTHER_SECRET: "s",
      }),
    ).toEqual({
      PATH: "/bin",
      KEY: "k",
    });
  });
});
