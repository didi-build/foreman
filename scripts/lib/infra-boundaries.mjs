/**
 * Cloudflare in infrastructure code lives only in its platform module (D-146), so adding a deploy
 * target never changes existing stacks. Naming the target ("cloudflare") is allowed elsewhere;
 * declaring its provider or resources is not.
 */
export const CLOUDFLARE_PLATFORM_DIR = "infra/modules/platform/cloudflare/";

const CLOUDFLARE_DECLARATIONS = [
  { pattern: /["']cloudflare\/cloudflare["']/, what: "the Cloudflare provider source" },
  { pattern: /^\s*provider\s+"cloudflare"/m, what: "a Cloudflare provider block" },
  {
    pattern: /^\s*(resource|data|ephemeral)\s+"cloudflare_/m,
    what: "a Cloudflare resource or data source",
  },
];

/**
 * @param {{ path: string, text: string }[]} files .tf files, paths relative to the repo root with forward slashes
 * @returns {{ path: string, what: string }[]}
 */
export function findInfraBoundaryViolations(files) {
  const violations = [];
  for (const { path, text } of files) {
    if (!path.endsWith(".tf") || path.startsWith(CLOUDFLARE_PLATFORM_DIR)) continue;
    const code = text.replace(/#.*$|\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const { pattern, what } of CLOUDFLARE_DECLARATIONS) {
      if (pattern.test(code)) violations.push({ path, what });
    }
  }
  return violations;
}
