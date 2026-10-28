import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findBootstrapTokenViolations } from "../scripts/check-secret-usage.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliScript = join(root, "scripts/check-secret-usage.mjs");

function runCli(cwd: string) {
  try {
    execFileSync("node", [cliScript], { cwd, encoding: "utf8", stdio: "pipe" });
    return { status: 0, stderr: "", stdout: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string; stdout?: string };
    return {
      status: e.status ?? 1,
      stderr: e.stderr ?? "",
      stdout: e.stdout ?? "",
    };
  }
}

describe("check-secret-usage (unit)", () => {
  it("allows BOOTSTRAP_TOKEN only in bootstrap.yml", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-usage-"));
    writeFileSync(
      join(dir, "bootstrap.yml"),
      "token: ${{ secrets.BOOTSTRAP_TOKEN }}\n",
    );
    writeFileSync(join(dir, "ci.yml"), "permissions:\n  contents: read\n");
    expect(findBootstrapTokenViolations(dir)).toEqual([]);

    writeFileSync(join(dir, "evil.yml"), "secrets.BOOTSTRAP_TOKEN\n");
    expect(findBootstrapTokenViolations(dir)).toEqual(["evil.yml"]);
  });

  it("returns no violations when the workflows directory is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-usage-missing-"));
    expect(findBootstrapTokenViolations(join(dir, ".github/workflows"))).toEqual([]);
  });
});

describe("check-secret-usage CLI (subprocess)", () => {
  it("exits 0 when .github/workflows is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-usage-cli-missing-"));
    expect(runCli(dir).status).toBe(0);
  });

  it("exits 0 when workflows are clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-usage-cli-clean-"));
    const workflows = join(dir, ".github/workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(workflows, "bootstrap.yml"), "token: ok\n");
    writeFileSync(join(workflows, "ci.yml"), "name: CI\n");
    expect(runCli(dir).status).toBe(0);
  });

  it("exits 1 when a non-bootstrap workflow mentions BOOTSTRAP_TOKEN", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-usage-cli-fail-"));
    const workflows = join(dir, ".github/workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(workflows, "bootstrap.yml"), "token: ok\n");
    writeFileSync(join(workflows, "leak.yml"), "secrets.BOOTSTRAP_TOKEN\n");
    const result = runCli(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leak.yml");
  });
});
