import { execFileSync } from "node:child_process";

export const dependabotAutomergeLabel = "launchpad-dependabot-automerge";

export function ensureDependabotAutomergeLabel(repo) {
  const names = JSON.parse(
    execFileSync(
      "gh",
      ["label", "list", "--repo", repo, "--limit", "200", "--json", "name"],
      { encoding: "utf8" },
    ),
  ).map((l) => l.name);
  if (names.includes(dependabotAutomergeLabel)) {
    return;
  }
  execFileSync(
    "gh",
    [
      "label",
      "create",
      dependabotAutomergeLabel,
      "--repo",
      repo,
      "--color",
      "1D76DB",
      "--description",
      "Dependabot minor/patch PR eligible for auto-merge when CI is green",
    ],
    { stdio: "inherit" },
  );
}
