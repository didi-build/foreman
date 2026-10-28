import { parseJsoncObject, replaceTopLevelStringProperty } from "./jsonc-lite.mjs";

/**
 * Parse wrangler.jsonc (comments and trailing commas allowed).
 *
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseWranglerJsonc(text) {
  return parseJsoncObject(text);
}

/**
 * Rename the top-level Worker `name` while preserving comments and formatting.
 *
 * @param {string} text
 * @param {string} expectedName
 * @param {string} newName
 * @param {{ configLabel?: string }} [options]
 * @returns {string}
 */
export function replaceWranglerWorkerName(text, expectedName, newName, options = {}) {
  const configLabel = options.configLabel ?? "wrangler.jsonc";
  const parsed = parseWranglerJsonc(text);
  if (parsed.name !== expectedName) {
    throw new Error(
      `${configLabel} name must be "${expectedName}" before rename (found "${String(parsed.name)}")`,
    );
  }
  const replaced = replaceTopLevelStringProperty(text, "name", expectedName, newName);
  const after = parseWranglerJsonc(replaced);
  if (after.name !== newName) {
    throw new Error(`${configLabel} name replacement failed`);
  }
  return replaced;
}
