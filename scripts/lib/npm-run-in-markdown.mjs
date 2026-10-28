/**
 * Escape a string for use inside a RegExp (literal match).
 * @param {string} value
 * @returns {string}
 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when markdown contains an exact backticked `npm run <scriptName>`.
 * @param {string} markdown
 * @param {string} scriptName
 */
export function markdownDocumentsNpmRunScript(markdown, scriptName) {
  const re = new RegExp("`npm run " + escapeRegExp(scriptName) + "`");
  return re.test(markdown);
}
