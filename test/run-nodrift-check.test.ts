import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldRunNodriftCheck } from "../scripts/lib/resolve-nodrift-cli.mjs";

const checkScript = join(
  fileURLToPath(new URL("..", import.meta.url)),
  "scripts/run-nodrift-check.mjs",
);

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

function runCheck(cwd: string) {
  try {
    const stdout = execFileSync("node", [checkScript], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "", stdout: String(stdout) };
  } catch (err) {
    const e = err as { status?: number; stderr?: string; stdout?: string };
    return {
      status: e.status ?? 1,
      stderr: e.stderr ?? "",
      stdout: e.stdout ?? "",
    };
  }
}

describe("shouldRunNodriftCheck (unit)", () => {
  it("is true when manifest or data-map exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodrift-gate-"));
    writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
    expect(shouldRunNodriftCheck(dir)).toBe(false);
    mkdirSync(join(dir, ".nodrift"), { recursive: true });
    writeFileSync(join(dir, ".nodrift/manifest.json"), "{}");
    expect(shouldRunNodriftCheck(dir)).toBe(true);
  });

  it("is true when only data-map.yml exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodrift-gate-"));
    mkdirSync(join(dir, "docs/privacy"), { recursive: true });
    writeFileSync(join(dir, "docs/privacy/data-map.yml"), "schema_version: 1\n");
    expect(shouldRunNodriftCheck(dir)).toBe(true);
  });
});

describe("run-nodrift-check (subprocess)", () => {
  it("prints skip line and exits 0 when neither gate file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodrift-check-"));
    writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
    const result = runCheck(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nodrift check skipped");
    expect(result.stdout).toContain("data-map.yml");
  });

  it("fails when manifest exists but the kit is not installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodrift-check-"));
    mkdirSync(join(dir, ".nodrift"), { recursive: true });
    writeFileSync(join(dir, ".nodrift/manifest.json"), '{"files":[]}\n');
    writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not installed");
  });

  it("runs nodrift check when only data-map.yml exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodrift-check-"));
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "x", devDependencies: { "@didi-build/nodrift": "0.1.0" } }, null, 2)}\n`,
    );
    const nm = join(dir, "node_modules");
    mkdirSync(nm, { recursive: true });
    symlinkSync(
      join(workspaceRoot, "node_modules", "@didi-build"),
      join(nm, "@didi-build"),
      "junction",
    );
    mkdirSync(join(dir, "docs/privacy"), { recursive: true });
    writeFileSync(join(dir, "docs/privacy/data-map.yml"), "schema_version: 1\n");
    writeFileSync(
      join(dir, "docs/privacy/subprocessors.yml"),
      "schema_version: 1\nsubprocessors: []\n",
    );
    expect(runCheck(dir).status).toBe(0);
  });

  it("runs nodrift check when manifest and kit are present", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodrift-check-"));
    mkdirSync(join(dir, ".nodrift"), { recursive: true });
    writeFileSync(join(dir, ".nodrift/manifest.json"), '{"files":[]}\n');
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "x", devDependencies: { "@didi-build/nodrift": "0.1.0" } }, null, 2)}\n`,
    );
    const nm = join(dir, "node_modules");
    mkdirSync(nm, { recursive: true });
    symlinkSync(
      join(workspaceRoot, "node_modules", "@didi-build"),
      join(nm, "@didi-build"),
      "junction",
    );
    mkdirSync(join(dir, "docs/privacy"), { recursive: true });
    writeFileSync(join(dir, "docs/privacy/data-map.yml"), "schema_version: 1\n");
    writeFileSync(
      join(dir, "docs/privacy/subprocessors.yml"),
      "schema_version: 1\nsubprocessors: []\n",
    );
    expect(runCheck(dir).status).toBe(0);
  });

  it("exits non-zero when nodrift check fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodrift-check-"));
    mkdirSync(join(dir, ".nodrift"), { recursive: true });
    writeFileSync(join(dir, ".nodrift/manifest.json"), '{"files":[]}\n');
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "x", devDependencies: { "@didi-build/nodrift": "0.1.0" } }, null, 2)}\n`,
    );
    const nm = join(dir, "node_modules");
    mkdirSync(nm, { recursive: true });
    symlinkSync(
      join(workspaceRoot, "node_modules", "@didi-build"),
      join(nm, "@didi-build"),
      "junction",
    );
    mkdirSync(join(dir, "docs/privacy"), { recursive: true });
    writeFileSync(join(dir, "docs/privacy/data-map.yml"), "schema_version: 99\n");
    writeFileSync(
      join(dir, "docs/privacy/subprocessors.yml"),
      "schema_version: 1\nsubprocessors: []\n",
    );
    expect(runCheck(dir).status).not.toBe(0);
  });
});
