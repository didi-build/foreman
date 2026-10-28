import { resolveGalleryPreviewMode } from "./lib/gallery-preview-mode.mjs";

const mode = resolveGalleryPreviewMode({
  credsReady: process.env.CREDS_READY === "true",
  previewOutcome: process.env.PREVIEW_OUTCOME ?? "skipped",
  probeOutcome: process.env.PROBE_OUTCOME ?? "skipped",
});

console.log(`mode=${mode}`);
