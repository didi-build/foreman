/**
 * Each provider in infrastructure code lives only in its platform module (D-146), so adding a
 * deploy target never changes existing stacks. Naming the target ("cloudflare") or a module path
 * is allowed elsewhere; declaring a provider or its resources is not. Two more rules from ADR 0110:
 * no file declares a `provider` block (providers read their tokens from the environment), and
 * `required_providers` appears only in a platform module, so stacks never name a provider.
 */
export const PLATFORM_PROVIDERS = [
  {
    name: "cloudflare",
    label: "Cloudflare",
    source: "cloudflare/cloudflare",
    dir: "infra/modules/platform/cloudflare/",
  },
  {
    name: "digitalocean",
    label: "DigitalOcean",
    source: "digitalocean/digitalocean",
    dir: "infra/modules/platform/digitalocean/",
  },
];

/** Kept for callers of the first version of this check. */
export const CLOUDFLARE_PLATFORM_DIR = PLATFORM_PROVIDERS[0].dir;

const PLATFORM_ROOT = "infra/modules/platform/";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function providerChecks(provider) {
  return [
    {
      pattern: new RegExp(`["']${escape(provider.source)}["']`),
      what: `the ${provider.label} provider source`,
    },
    {
      pattern: new RegExp(`^\\s*(resource|data|ephemeral)\\s+"${provider.name}_`, "m"),
      what: `a ${provider.label} resource or data source`,
    },
  ];
}

const PROVIDER_BLOCK = /^\s*provider\s+"[^"]+"/m;
const REQUIRED_PROVIDERS = /^\s*required_providers\s*\{/m;

const fixFor = (provider) =>
  `${provider.label} belongs only in ${provider.dir} (D-146).`;
const PROVIDER_BLOCK_FIX =
  "No module or stack configures a provider; each reads its token from the environment (ADR 0110).";
const REQUIRED_PROVIDERS_FIX =
  "Providers are declared only in their platform module under infra/modules/platform/ (D-146).";

/** OpenTofu's JSON syntax: block types and names are object keys. Parsed, not pattern-matched. */
function jsonDeclarations(path, text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return [
      {
        what: "a file that is not valid JSON, so it cannot be checked",
        fix: "Fix the JSON.",
      },
    ];
  }
  const found = [];
  const blocks = (key) => [doc?.[key] ?? []].flat();
  const names = (block) =>
    block && typeof block === "object" ? Object.keys(block) : [];
  const requiredProviders = blocks("terraform").flatMap((t) =>
    [t?.required_providers ?? []].flat(),
  );
  if (blocks("provider").some((b) => names(b).length > 0))
    found.push({ what: "a provider block", fix: PROVIDER_BLOCK_FIX });
  for (const provider of PLATFORM_PROVIDERS) {
    if (path.startsWith(provider.dir)) continue;
    const prefix = `${provider.name}_`;
    for (const key of ["resource", "data", "ephemeral"]) {
      if (blocks(key).some((b) => names(b).some((n) => n.startsWith(prefix))))
        found.push({
          what: `a ${provider.label} resource or data source`,
          fix: fixFor(provider),
        });
    }
    if (JSON.stringify(requiredProviders).includes(provider.source))
      found.push({
        what: `the ${provider.label} provider source`,
        fix: fixFor(provider),
      });
  }
  if (
    !path.startsWith(PLATFORM_ROOT) &&
    requiredProviders.some(
      (r) => r && typeof r === "object" && Object.keys(r).length > 0,
    )
  )
    found.push({ what: "a required_providers block", fix: REQUIRED_PROVIDERS_FIX });
  const seen = new Set();
  return found.filter((f) => !seen.has(f.what) && seen.add(f.what));
}

/**
 * @param {{ path: string, text: string }[]} files .tf and .tf.json files, paths relative to the repo root with forward slashes
 * @returns {{ path: string, what: string, fix: string }[]}
 */
export function findInfraBoundaryViolations(files) {
  const violations = [];
  for (const { path, text } of files) {
    if (path.endsWith(".tf.json")) {
      for (const found of jsonDeclarations(path, text))
        violations.push({ path, ...found });
      continue;
    }
    if (!path.endsWith(".tf")) continue;
    const code = text.replace(/#.*$|\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (PROVIDER_BLOCK.test(code))
      violations.push({ path, what: "a provider block", fix: PROVIDER_BLOCK_FIX });
    for (const provider of PLATFORM_PROVIDERS) {
      if (path.startsWith(provider.dir)) continue;
      for (const { pattern, what } of providerChecks(provider)) {
        if (pattern.test(code)) violations.push({ path, what, fix: fixFor(provider) });
      }
    }
    if (!path.startsWith(PLATFORM_ROOT) && REQUIRED_PROVIDERS.test(code))
      violations.push({
        path,
        what: "a required_providers block",
        fix: REQUIRED_PROVIDERS_FIX,
      });
  }
  return violations;
}
