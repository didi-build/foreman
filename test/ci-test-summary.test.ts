import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runSummary(env: Record<string, string>) {
  const out = execFileSync("node", ["scripts/ci-test-summary.mjs"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const match = out.match(/body<<EOF\n([\s\S]*?)\nEOF/);
  return match?.[1] ?? "";
}

describe("ci-test-summary (unit)", () => {
  it("reports install failure clearly for Dependabot-style CI", () => {
    const body = runSummary({
      INSTALL_OUTCOME: "failure",
      CHECK_OUTCOME: "skipped",
      PR_HEAD_SHA: "abcdef1234567890",
    });
    expect(body).toContain("<!-- launchpad-vitest-results -->");
    expect(body).toContain("npm ci");
    expect(body).toContain("dependency install failed");
    expect(body).toContain("`abcdef1`");
    expect(body).not.toContain("Vitest");
  });

  it("includes check outcome when install succeeds", () => {
    const body = runSummary({
      INSTALL_OUTCOME: "success",
      CHECK_OUTCOME: "success",
      PR_HEAD_SHA: "deadbeef00000000",
    });
    expect(body).toContain("**check**");
    expect(body).toContain("`success`");
    expect(body).toContain("preview-workflow");
    expect(body).toContain("attribution");
  });
});
