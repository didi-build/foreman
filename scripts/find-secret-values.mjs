// Fail if any file contains a secret value. Usage (values come from the environment, never argv):
//   SECRET_ENV_NAMES=CANARY,CF_TOKEN node scripts/find-secret-values.mjs plan.txt state.json
import { readFileSync } from "node:fs";
import { findSecretValues, secretsFromEnv } from "./lib/find-secret-values.mjs";

const names = (process.env.SECRET_ENV_NAMES ?? "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);
const files = process.argv.slice(2);
if (names.length === 0 || files.length === 0) {
  console.error(
    "Set SECRET_ENV_NAMES to the names of variables holding secrets, and pass files to scan.",
  );
  process.exit(2);
}
const { secrets, problems } = secretsFromEnv(names, process.env);
if (problems.length > 0) {
  console.error(`Cannot scan: ${problems.join("; ")}.`);
  process.exit(2);
}
const hits = findSecretValues(
  files.map((file) => ({ name: file, text: readFileSync(file, "utf8") })),
  secrets,
);
for (const hit of hits)
  console.error(`Secret value of ${hit.secret} found in ${hit.text}.`);
console.log(
  `Scanned ${files.length} file(s) for ${names.length} secret value(s): ${hits.length} found.`,
);
process.exit(hits.length > 0 ? 1 : 0);
