// Fail if a provider is declared in infra/ outside its platform module, or if any file configures a
// provider (D-146, ADR 0110).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { findInfraBoundaryViolations } from "./lib/infra-boundaries.mjs";

function listTfFiles(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === ".terraform" ? [] : listTfFiles(path);
    return /\.tf(\.json)?$/.test(entry.name) ? [path] : [];
  });
}

const files = listTfFiles("infra").map((path) => ({
  path: relative(".", path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));
const violations = findInfraBoundaryViolations(files);
for (const { path, what, fix } of violations) {
  console.error(`${path}: declares ${what}. ${fix}`);
}
console.log(
  `Checked ${files.length} .tf and .tf.json file(s): ${violations.length} infrastructure boundary violation(s).`,
);
process.exit(violations.length > 0 ? 1 : 0);
