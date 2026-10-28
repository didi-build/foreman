/** An exact version, optionally with a pre-release or build tag, for example 1.2.3 or 1.2.3-rc.1. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const PINNED_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
];

/**
 * List every package.json dependency whose version is not exact (ADR 0101).
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
