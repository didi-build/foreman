/**
 * @param {{ credsReady: boolean; previewOutcome: string; probeOutcome: string }} input
 * @returns {"unconfigured" | "deployed" | "failed"}
 */
export function resolveGalleryPreviewMode({
  credsReady,
  previewOutcome,
  probeOutcome,
}) {
  if (!credsReady) {
    return "unconfigured";
  }
  if (previewOutcome === "success" && probeOutcome === "success") {
    return "deployed";
  }
  return "failed";
}
