import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("repo-settings (unit)", () => {
  it("prints a dry-run by default", () => {
    const out = execFileSync("node", ["scripts/repo-settings.mjs"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "didi-build/example" },
    });
    expect(out).toContain("Dry run");
    expect(out).toContain("required_approving_review_count");
    expect(out).toContain("--input -");
    expect(out).toContain("allow_auto_merge");
    expect(out).toContain("allow_squash_merge");
    expect(out).toContain('"allow_merge_commit": false');
    expect(out).toContain('"check"');
  });
});
