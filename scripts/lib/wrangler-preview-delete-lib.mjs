import { spawnSync } from "node:child_process";
import {
  PREVIEW_CONFIG,
  isAllowedPreviewWranglerConfig,
} from "./wrangler-config-path.mjs";

/**
 * @param {string} detail
 * @param {string} previewName
 * @returns {boolean}
 */
export function isPreviewMissingError(detail, previewName) {
  const raw = previewName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const encoded = encodeURIComponent(previewName).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const nameInUrl = raw === encoded ? raw : `(?:${raw}|${encoded})`;
  const apiLine = new RegExp(
    `A request to the Cloudflare API \\(/accounts/[^)]+/workers/workers/[^/]+/previews/${nameInUrl}\\) failed\\.`,
  );
  return apiLine.test(detail) && /\[code:\s*10025\]/.test(detail);
}

/**
 * @param {string} name
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} [spawnOptions]
 * @returns {number}
 */
export function deletePreviewByName(name, spawnOptions = {}) {
  const configPath = process.env.WRANGLER_CONFIG;
  if (!isAllowedPreviewWranglerConfig(configPath)) {
    console.error(
      `WRANGLER_CONFIG must be ${PREVIEW_CONFIG} for preview cleanup (found "${configPath ?? ""}").`,
    );
    return 1;
  }
  const wranglerArgs = [
    "wrangler",
    "preview",
    "delete",
    "--name",
    name,
    "--skip-confirmation",
  ];
  wranglerArgs.push("-c", PREVIEW_CONFIG);
  const result = spawnSync("npx", wranglerArgs, {
    encoding: "utf8",
    env: process.env,
    ...spawnOptions,
  });

  if (result.status === 0) {
    console.log(`Deleted preview ${name}.`);
    return 0;
  }

  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  if (isPreviewMissingError(detail, name)) {
    console.log(`Preview ${name} was not present; nothing to delete.`);
    return 0;
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  return result.status ?? 1;
}
