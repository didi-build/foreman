import { describe, expect, it } from "vitest";
import {
  branchProtectionReadFailureReason,
  parseGhHttpStatus,
} from "../scripts/lib/gh-api-errors.mjs";

describe("gh-api-errors (unit)", () => {
  it("parses HTTP status from gh api stderr", () => {
    expect(
      parseGhHttpStatus("gh: Resource not accessible by integration (HTTP 403)"),
    ).toBe(403);
    expect(
      parseGhHttpStatus('gh: Not Found (HTTP 404): {"message":"Branch not protected"}'),
    ).toBe(404);
    expect(parseGhHttpStatus("network error")).toBeNull();
  });

  it("maps HTTP status to branch protection read messages", () => {
    expect(branchProtectionReadFailureReason(404, "x")).toContain("HTTP 404");
    expect(branchProtectionReadFailureReason(403, "x")).toContain("HTTP 403");
    expect(branchProtectionReadFailureReason(null, "boom")).toContain("boom");
  });
});
