import { describe, expect, it } from "vitest";
import { resolveGalleryPreviewMode } from "../scripts/lib/gallery-preview-mode.mjs";

describe("resolveGalleryPreviewMode (unit)", () => {
  it("returns unconfigured when credentials are missing", () => {
    expect(
      resolveGalleryPreviewMode({
        credsReady: false,
        previewOutcome: "skipped",
        probeOutcome: "skipped",
      }),
    ).toBe("unconfigured");
  });

  it("returns deployed only when deploy and probe both succeed", () => {
    expect(
      resolveGalleryPreviewMode({
        credsReady: true,
        previewOutcome: "success",
        probeOutcome: "success",
      }),
    ).toBe("deployed");
  });

  it("returns failed when deploy fails (probe skipped)", () => {
    expect(
      resolveGalleryPreviewMode({
        credsReady: true,
        previewOutcome: "failure",
        probeOutcome: "skipped",
      }),
    ).toBe("failed");
  });

  it("returns failed when deploy succeeds but probe fails", () => {
    expect(
      resolveGalleryPreviewMode({
        credsReady: true,
        previewOutcome: "success",
        probeOutcome: "failure",
      }),
    ).toBe("failed");
  });
});
