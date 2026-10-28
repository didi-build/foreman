import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ATTRIBUTION_START = "<!-- launchpad-attribution:start -->";
export const ATTRIBUTION_END = "<!-- launchpad-attribution:end -->";
export const LAUNCHPAD_LICENSE_PATH = "LICENSES/launchpad-MIT.txt";
export const README_PATH = "README.md";

/**
 * @param {string} [root="."]
 * @returns {{ failed: boolean; warnings: string[]; skipped?: boolean }}
 */
export function checkAttribution(root = ".") {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.launchpadTemplate === true) {
    return { failed: false, warnings: [], skipped: true };
  }

  const warnings = [];
  let failed = false;
  const licensePath = join(root, LAUNCHPAD_LICENSE_PATH);
  const readmePath = join(root, README_PATH);

  if (!existsSync(licensePath)) {
    failed = true;
  }

  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, "utf8");
    const hasBlock =
      readme.includes(ATTRIBUTION_START) && readme.includes(ATTRIBUTION_END);
    if (!hasBlock) {
      warnings.push(
        `Warning: ${README_PATH} is missing the Launchpad attribution block (${ATTRIBUTION_START} … ${ATTRIBUTION_END}).`,
      );
    }
  } else {
    warnings.push(
      `Warning: ${README_PATH} not found; cannot verify attribution block.`,
    );
  }

  return { failed, warnings, skipped: false };
}
