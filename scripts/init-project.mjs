import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { envWithoutBootstrapTokens } from "./lib/bootstrap-token-env.mjs";
import {
  parseInteractivePersonalDataAnswer,
  parsePersonalDataFlags,
  resolveCollectsPersonalData,
} from "./lib/collects-personal-data.mjs";
import {
  formatNodriftMissingError,
  resolveNodriftCli,
} from "./lib/resolve-nodrift-cli.mjs";
import { replaceWranglerWorkerName } from "./lib/parse-wrangler-jsonc.mjs";
import { validateWorkerSlug } from "./lib/worker-slug.mjs";

const README_TEMPLATE = "README.project.md";
const LICENSE_TEMPLATE = "LICENSE.project";

const rawArgv = process.argv.slice(2);
const { positional } = parsePersonalDataFlags(rawArgv);
const slug = positional[0];
const displayName = positional[1];
const purposeArg = positional[2];
const ownerArg = positional[3];

if (!slug || !displayName) {
  console.error(
    'Usage: npm run init-project -- <slug> "<display name>" ["<one-line purpose>"] ["<owner>"] [--personal-data | --no-personal-data]',
  );
  console.error(
    "Non-interactive: set LAUNCHPAD_COLLECTS_PERSONAL_DATA=true|false or pass a personal-data flag.",
  );
  process.exit(1);
}

if (positional.length > 4) {
  console.error("Too many arguments.");
  process.exit(1);
}

const slugValidation = validateWorkerSlug(slug);
if (!slugValidation.ok) {
  console.error(slugValidation.message);
  process.exit(1);
}

if (!statSync(README_TEMPLATE, { throwIfNoEntry: false })?.isFile()) {
  console.error(
    `Missing ${README_TEMPLATE} (already initialized, or not a Launchpad checkout).`,
  );
  process.exit(1);
}

if (!statSync(LICENSE_TEMPLATE, { throwIfNoEntry: false })?.isFile()) {
  console.error(
    `Missing ${LICENSE_TEMPLATE} (already initialized, or not a Launchpad checkout).`,
  );
  process.exit(1);
}

async function askCollectsPersonalData() {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Will this project collect personal data? (Y/n) ");
    return parseInteractivePersonalDataAnswer(answer);
  } finally {
    rl.close();
  }
}

let resolved;
try {
  resolved = await resolveCollectsPersonalData({
    argv: rawArgv,
    env: process.env,
    isInteractive: Boolean(process.stdin.isTTY),
    ask: askCollectsPersonalData,
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}

if (resolved.collects) {
  const nodrift = resolveNodriftCli(process.cwd());
  if (!nodrift.ok) {
    console.error(formatNodriftMissingError({ context: "init" }));
    process.exit(1);
  }
}

const wranglerPath = "wrangler.jsonc";
const wranglerPreviewPath = "wrangler.preview.jsonc";
let wranglerRenamed = null;
let wranglerPreviewRenamed = null;
if (statSync(wranglerPath, { throwIfNoEntry: false })?.isFile()) {
  const wranglerText = readFileSync(wranglerPath, "utf8");
  try {
    wranglerRenamed = replaceWranglerWorkerName(wranglerText, "launchpad", slug);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
if (statSync(wranglerPreviewPath, { throwIfNoEntry: false })?.isFile()) {
  const wranglerPreviewText = readFileSync(wranglerPreviewPath, "utf8");
  try {
    wranglerPreviewRenamed = replaceWranglerWorkerName(
      wranglerPreviewText,
      "launchpad-preview",
      `${slug}-preview`,
      { configLabel: "wrangler.preview.jsonc" },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}

const purpose =
  purposeArg ??
  "Short description of what this project does — edit README and docs/architecture/overview.md.";
const owner = ownerArg ?? "Didi Build";
const year = String(new Date().getUTCFullYear());

const replacements = new Map([
  ["{{PROJECT_SLUG}}", slug],
  ["{{PROJECT_NAME}}", displayName],
  ["{{PROJECT_PURPOSE}}", purpose],
  ["{{PROJECT_YEAR}}", year],
  ["{{PROJECT_OWNER}}", owner],
]);

function listFiles(path) {
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    return [path];
  }
  const out = [];
  for (const name of readdirSync(path)) {
    if (name.startsWith(".")) continue;
    const child = join(path, name);
    const st = statSync(child);
    if (st.isDirectory()) out.push(...listFiles(child));
    else if (st.isFile()) out.push(child);
  }
  return out;
}

const textFiles = [
  README_TEMPLATE,
  LICENSE_TEMPLATE,
  "AGENTS.md",
  "package.json",
  ...listFiles("docs"),
  ...listFiles("design"),
  ...listFiles("components"),
  ...listFiles("gallery"),
  ...listFiles(".github"),
  ".cursor/rules/launchpad.mdc",
  "CLAUDE.md",
];

for (const file of textFiles) {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
  let text = readFileSync(file, "utf8");
  for (const [from, to] of replacements) {
    text = text.replaceAll(from, to);
  }
  writeFileSync(file, text);
}

const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = slug;
pkg.description = purpose;
pkg.license = "UNLICENSED";
delete pkg.launchpadTemplate;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

if (wranglerRenamed !== null) {
  writeFileSync(wranglerPath, wranglerRenamed);
}
if (wranglerPreviewRenamed !== null) {
  writeFileSync(wranglerPreviewPath, wranglerPreviewRenamed);
}

const exampleFiles = ["src/greet.ts", "test/greet.test.ts"];
for (const file of exampleFiles) {
  if (statSync(file, { throwIfNoEntry: false })?.isFile()) {
    unlinkSync(file);
  }
}
mkdirSync("src", { recursive: true });
writeFileSync("src/.gitkeep", "");

renameSync(README_TEMPLATE, "README.md");
renameSync(LICENSE_TEMPLATE, "LICENSE");

if (resolved.collects) {
  const nodrift = resolveNodriftCli(process.cwd());
  const init = spawnSync(process.execPath, [nodrift.cliPath, "init"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: envWithoutBootstrapTokens(process.env),
  });
  if (init.stdout) {
    process.stdout.write(init.stdout);
  }
  if (init.stderr) {
    process.stderr.write(init.stderr);
  }
  if (init.status !== 0) {
    console.error("nodrift init failed.");
    process.exit(init.status ?? 1);
  }
}

console.log(`Initialized project "${displayName}" (${slug}).`);
if (resolved.collects) {
  console.log("Privacy scaffolding: @didi-build/nodrift init completed.");
} else {
  console.log(
    "Privacy scaffolding: skipped (no personal data). To add it later: npx nodrift init, then npm run check.",
  );
}
console.log("Next: npm install && npm run check");
