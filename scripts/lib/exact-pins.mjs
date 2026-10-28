const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const PINNED_SECTIONS = ["dependencies", "devDependencies", "overrides"];

/**
 * List every package.json dependency whose version is not an exact `x.y.z` (ADR 0101).
 * @param {Record<string, unknown>} pkg parsed package.json
 * @returns {{ section: string, name: string, version: string }[]}
 */
export function findNonExactPins(pkg) {
  const offenders = [];
  for (const section of PINNED_SECTIONS) {
    const entries = /** @type {Record<string, string> | undefined} */ (pkg[section]);
    for (const [name, version] of Object.entries(entries ?? {})) {
      if (!EXACT_VERSION.test(version)) offenders.push({ section, name, version });
    }
  }
  return offenders;
}
