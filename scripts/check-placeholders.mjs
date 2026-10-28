import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PLACEHOLDER = /\{\{[A-Z0-9_]+\}\}/g;

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.launchpadTemplate === true) {
  process.exit(0);
}

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

const files = ["README.md", "AGENTS.md", "package.json", ...listFiles("docs")];

const offenders = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const matches = [...text.matchAll(PLACEHOLDER)].map((m) => m[0]);
  if (matches.length > 0) {
    offenders.push({ file, matches: [...new Set(matches)] });
  }
}

if (offenders.length > 0) {
  console.error("Unreplaced Launchpad placeholders found:\n");
  for (const { file, matches } of offenders) {
    console.error(`  ${file}: ${matches.join(", ")}`);
  }
  console.error('\nRun: npm run init-project -- <slug> "<display name>"');
  process.exit(1);
}
