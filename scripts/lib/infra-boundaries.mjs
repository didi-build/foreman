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

/** OpenTofu's JSON syntax: block types and names are object keys. Parsed, not pattern-matched. */
function jsonDeclarations(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return ["a file that is not valid JSON, so it cannot be checked"];
  }
  const found = [];
  const blocks = (key) => [doc?.[key] ?? []].flat();
  const names = (block) =>
    block && typeof block === "object" ? Object.keys(block) : [];
  if (blocks("provider").some((b) => names(b).includes("cloudflare")))
    found.push("a Cloudflare provider block");
  for (const key of ["resource", "data", "ephemeral"]) {
    if (blocks(key).some((b) => names(b).some((n) => n.startsWith("cloudflare_"))))
      found.push("a Cloudflare resource or data source");
  }
  const requiredProviders = blocks("terraform").flatMap((t) =>
    [t?.required_providers ?? []].flat(),
  );
  if (JSON.stringify(requiredProviders).includes("cloudflare/cloudflare"))
    found.push("the Cloudflare provider source");
  return [...new Set(found)];
}

/**
 * @param {{ path: string, text: string }[]} files .tf and .tf.json files, paths relative to the repo root with forward slashes
 * @returns {{ path: string, what: string }[]}
 */
export function findInfraBoundaryViolations(files) {
  const violations = [];
  for (const { path, text } of files) {
    if (path.startsWith(CLOUDFLARE_PLATFORM_DIR)) continue;
    if (path.endsWith(".tf.json")) {
      for (const what of jsonDeclarations(text)) violations.push({ path, what });
      continue;
    }
    if (!path.endsWith(".tf")) continue;
    const code = text.replace(/#.*$|\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const { pattern, what } of CLOUDFLARE_DECLARATIONS) {
      if (pattern.test(code)) violations.push({ path, what });
    }
  }
  return violations;
}
