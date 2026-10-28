import { describe, expect, it } from "vitest";
import { isPreviewMissingError } from "../scripts/lib/wrangler-preview-delete-lib.mjs";

/**
 * Wrangler 4.152.0 `preview delete` surfaces API failures via `throwFetchError`
 * (wrangler-dist/cli.js): main line `A request to the Cloudflare API (${resource}) failed.`
 * with a note `renderError` line including `[code: N]`. `deletePreview` calls DELETE on
 * `/accounts/.../workers/workers/{worker}/previews/{name}`; missing preview uses code 10025
 * (`PREVIEW_NOT_FOUND_ERR_CODE`). Envelope confirmed by running `wrangler preview delete` 4.152.0
 * without valid credentials; note text follows a live API 404-style response for code 10025.
 */
const WRANGLER_PREVIEW_DELETE_NOT_FOUND = `✘ [ERROR] A request to the Cloudflare API (/accounts/00000000000000000000000000000001/workers/workers/launchpad/previews/pr-42) failed.

  Resource not found [code: 10025]

  If you think this is a bug, please open an issue at: https://github.com/cloudflare/workers-sdk/issues/new/choose`;

describe("isPreviewMissingError (unit)", () => {
  it("treats wrangler preview delete API not-found (code 10025) as missing", () => {
    expect(isPreviewMissingError(WRANGLER_PREVIEW_DELETE_NOT_FOUND, "pr-42")).toBe(
      true,
    );
  });

  it("does not treat generic HTTP 404 as missing preview", () => {
    expect(isPreviewMissingError("Error: HTTP 404 Not Found", "pr-42")).toBe(false);
  });

  it("does not treat preview delete worker-not-found on the previews URL as missing preview", () => {
    const detail = `A request to the Cloudflare API (/accounts/abc/workers/workers/launchpad/previews/pr-1) failed.

  Worker not found [code: 10007]`;
    expect(isPreviewMissingError(detail, "pr-1")).toBe(false);
  });

  it("does not treat preview delete with a different API error code as missing preview", () => {
    const detail = `A request to the Cloudflare API (/accounts/abc/workers/workers/launchpad/previews/pr-1) failed.

  Authentication error [code: 10000]`;
    expect(isPreviewMissingError(detail, "pr-1")).toBe(false);
  });

  it("does not treat preview delete failures without not-found as missing", () => {
    expect(
      isPreviewMissingError("Preview pr-1 failed to delete: rate limited", "pr-1"),
    ).toBe(false);
  });

  it("does not treat preview secret not-found copy as missing preview delete", () => {
    const detail = `The Preview "pr-42" was not found. Please check the Preview name, or create it with \`wrangler preview\`. [code: 10025]`;
    expect(isPreviewMissingError(detail, "pr-42")).toBe(false);
  });

  it("does not treat auth or generic errors as missing", () => {
    expect(isPreviewMissingError("Authentication error [code: 10000]", "pr-1")).toBe(
      false,
    );
    expect(isPreviewMissingError("Resource not found for token", "pr-1")).toBe(false);
    expect(isPreviewMissingError("does not exist", "pr-1")).toBe(false);
  });

  it("does not treat a different API resource with code 10025 as missing preview", () => {
    const detail = `A request to the Cloudflare API (/accounts/abc/workers/workers/launchpad/versions/pr-42) failed.

  Resource not found [code: 10025]`;
    expect(isPreviewMissingError(detail, "pr-42")).toBe(false);
  });

  it("does not treat previews URL for another preview name as missing preview", () => {
    const detail = `A request to the Cloudflare API (/accounts/abc/workers/workers/launchpad/previews/pr-42) failed.

  Resource not found [code: 10025]`;
    expect(isPreviewMissingError(detail, "pr-1")).toBe(false);
    expect(isPreviewMissingError(detail, "pr-4")).toBe(false);
  });
});
