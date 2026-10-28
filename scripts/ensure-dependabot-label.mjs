import { ensureDependabotAutomergeLabel } from "./lib/dependabot-label.mjs";

const repo = process.env.REPOSITORY ?? process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.error("Set REPOSITORY or GITHUB_REPOSITORY");
  process.exit(1);
}
ensureDependabotAutomergeLabel(repo);
