import { deletePreviewByName } from "./lib/wrangler-preview-delete-lib.mjs";

const name = process.env.PREVIEW_NAME;
if (!name) {
  console.error("PREVIEW_NAME is required.");
  process.exit(1);
}

process.exit(deletePreviewByName(name));
