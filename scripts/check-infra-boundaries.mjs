// Fail if Cloudflare is declared in infra/ outside its platform module (D-146).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  CLOUDFLARE_PLATFORM_DIR,
  findInfraBoundaryViolations,
} from "./lib/infra-boundaries.mjs";

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
for (const { path, what } of violations) {
  console.error(
    `${path}: declares ${what}. Cloudflare belongs only in ${CLOUDFLARE_PLATFORM_DIR} (D-146).`,
  );
}
console.log(
  `Checked ${files.length} .tf and .tf.json file(s): ${violations.length} infrastructure boundary violation(s).`,
);
process.exit(violations.length > 0 ? 1 : 0);
