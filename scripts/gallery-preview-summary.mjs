const marker = "<!-- launchpad-gallery-preview -->";
const previewUrl = process.env.PREVIEW_URL ?? "";
const galleryUrl = previewUrl ? `${previewUrl.replace(/\/$/, "")}/gallery` : "";
const sha = (process.env.PR_HEAD_SHA ?? "").slice(0, 7);
const previewMode = process.env.PREVIEW_MODE ?? "unknown";

let statusLine;
if (previewMode === "unconfigured") {
  statusLine =
    "**Gallery preview:** not configured. Add repository secrets `CLOUDFLARE_API_TOKEN_PREVIEW` (Workers Scripts Edit only; do not grant D1 or R2 Edit because PR-branch code can reach this token) and `CLOUDFLARE_ACCOUNT_ID`. Same-repo pull requests only; fork PRs skip preview deploy.";
} else if (previewMode === "deployed" && galleryUrl) {
  statusLine = `✅ **Gallery preview:** [Open /gallery](${galleryUrl})`;
} else if (previewMode === "failed") {
  statusLine =
    "❌ **Gallery preview:** deploy or /gallery probe did not pass (check the workflow log).";
} else {
  statusLine =
    "❌ **Gallery preview:** unexpected preview state (check the workflow log).";
}

const body = `${marker}
${statusLine}

Commit: \`${sha}\``;

if (process.env.OUTPUT_MODE === "body") {
  console.log(body);
} else {
  console.log(`body<<EOF\n${body}\nEOF`);
}
