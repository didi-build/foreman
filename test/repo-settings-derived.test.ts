import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const initScript = join(root, "scripts/init-project.mjs");
const repoSettingsScript = join(root, "scripts/repo-settings.mjs");

describe("repo-settings on derived project (unit)", () => {
  it("dry-runs after init-project without calling GitHub", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-derived-"));
    writeFileSync(
      join(dir, "README.project.md"),
      "# {{PROJECT_NAME}}\n\n{{PROJECT_PURPOSE}}\n",
    );
    writeFileSync(
      join(dir, "LICENSE.project"),
      "Copyright (c) {{PROJECT_YEAR}} {{PROJECT_OWNER}}. All rights reserved.\n",
    );
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "launchpad", launchpadTemplate: true }, null, 2)}\n`,
    );
    execFileSync("node", [initScript, "demo", "Demo App", "--no-personal-data"], {
      cwd: dir,
      encoding: "utf8",
    });
    const out = execFileSync("node", [repoSettingsScript], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "didi-build/demo-app" },
    });
    expect(out).toContain("Dry run");
    expect(out).toContain("required_approving_review_count");
    expect(out).toContain('"strict": false');
    expect(out).toContain("LAUNCHPAD_JSON");
  });
});
