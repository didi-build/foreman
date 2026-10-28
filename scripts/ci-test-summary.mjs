import { existsSync, readFileSync } from "node:fs";

const marker = "<!-- launchpad-vitest-results -->";
const checkOutcome = process.env.CHECK_OUTCOME ?? "unknown";
const installOutcome = process.env.INSTALL_OUTCOME ?? "unknown";
const sha = (process.env.PR_HEAD_SHA ?? "").slice(0, 7);

const lines = [];

if (installOutcome !== "success") {
  lines.push(
    `❌ **npm ci** - \`${installOutcome}\` (dependency install failed; tests and check did not run)`,
  );
  lines.push(
    "_Common on major Dependabot bumps: peer dependency conflicts. Review the workflow log for the npm ci step._",
  );
} else {
  let testLine = "_Tests did not run or JUnit output is missing._";
  const junitPath = "test-results/junit.xml";
  if (existsSync(junitPath)) {
    const xml = readFileSync(junitPath, "utf8");
    const tests = Number(xml.match(/tests="(\d+)"/)?.[1] ?? 0);
    const failures = Number(xml.match(/failures="(\d+)"/)?.[1] ?? 0);
    const errors = Number(xml.match(/errors="(\d+)"/)?.[1] ?? 0);
    const failed = failures + errors;
    const passed = Math.max(0, tests - failed);
    const icon = failed === 0 ? "✅" : "❌";
    testLine = `${icon} **Vitest** - ${passed}/${tests} passed (${failed} failed)`;
  }
  lines.push(testLine);

  const checkIcon = checkOutcome === "success" ? "✅" : "❌";
  lines.push(
    `${checkIcon} **check** - \`${checkOutcome}\` (format, lint, typecheck, test, secrets, secret-usage, preview-workflow, placeholders, attribution)`,
  );
}

const body = `${marker}
${lines.join("\n\n")}

Commit: \`${sha}\``;

if (process.env.OUTPUT_MODE === "body") {
  console.log(body);
} else {
  console.log(`body<<EOF\n${body}\nEOF`);
}
