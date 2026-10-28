import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveNodriftCli } from "../scripts/lib/resolve-nodrift-cli.mjs";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

describe("resolve-nodrift-cli (unit)", () => {
  it("resolves the kit from the Launchpad workspace", () => {
    const resolved = resolveNodriftCli(workspaceRoot);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.cliPath).toContain("@didi-build/nodrift");
    }
  });

  it("returns not-installed when package.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodrift-resolve-"));
    expect(resolveNodriftCli(dir)).toEqual({
      ok: false,
      reason: "not-installed",
    });
  });

  it("returns not-installed when the dependency is not installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodrift-resolve-"));
    writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
    expect(resolveNodriftCli(dir)).toEqual({
      ok: false,
      reason: "not-installed",
    });
  });
});
