import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runSummary(env: Record<string, string>) {
  const out = execFileSync("node", ["scripts/gallery-preview-summary.mjs"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const match = out.match(/body<<EOF\n([\s\S]*?)\nEOF/);
  return match?.[1] ?? "";
}

describe("gallery-preview-summary (unit)", () => {
  it("explains unconfigured previews without treating them as deploy failures", () => {
    const body = runSummary({
      PREVIEW_MODE: "unconfigured",
      PR_HEAD_SHA: "abcdef1234567890",
    });
    expect(body).toContain("<!-- launchpad-gallery-preview -->");
    expect(body).toContain("not configured");
    expect(body).toContain("CLOUDFLARE_API_TOKEN_PREVIEW");
    expect(body).toContain("Workers Scripts Edit only");
    expect(body).not.toContain("deploy did not complete");
  });

  it("reports failure when mode is failed", () => {
    const body = runSummary({
      PREVIEW_MODE: "failed",
      PR_HEAD_SHA: "abcdef1234567890",
    });
    expect(body).toContain("probe did not pass");
    expect(body).not.toContain("Open /gallery");
  });

  it("links to /gallery when deployed", () => {
    const body = runSummary({
      PREVIEW_MODE: "deployed",
      PREVIEW_URL: "https://example.workers.dev",
      PR_HEAD_SHA: "abcdef1234567890",
    });
    expect(body).toContain("/gallery");
    expect(body).toContain("https://example.workers.dev/gallery");
  });
});
