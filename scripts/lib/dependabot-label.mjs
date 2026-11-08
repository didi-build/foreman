import { execFileSync } from "node:child_process";
import {
  dependabotAutomergeLabel,
  dependabotAutomergeLabelColor,
  dependabotAutomergeLabelDescription,
} from "../../.github/scripts/bootstrap-settings.mjs";

export { dependabotAutomergeLabel };

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
      dependabotAutomergeLabelColor,
      "--description",
      dependabotAutomergeLabelDescription,
    ],
    { stdio: "inherit" },
  );
}
