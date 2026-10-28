import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Every service folder under src/ with a Dockerfile (ADR 0111). */
const services = readdirSync("src", { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(join("src", entry.name, "Dockerfile")),
  )
  .map((entry) => entry.name);

interface DependabotUpdate {
  "package-ecosystem": string;
  directory?: string;
  directories?: string[];
}
const dependabot = parse(readFileSync(".github/dependabot.yml", "utf8")) as {
  updates: DependabotUpdate[];
};
const dockerDirectories = dependabot.updates
  .filter((update) => update["package-ecosystem"] === "docker")
  .flatMap(
    (update) => update.directories ?? (update.directory ? [update.directory] : []),
  );

describe("service Dockerfiles (unit: container conventions guard, ADR 0111)", () => {
  it("finds the reference service, so the checks below cannot pass on an empty list", () => {
    expect(services).toContain("sample-service");
  });

  it.each(services)("%s pins every base image by digest", (service) => {
    const fromLines = readFileSync(join("src", service, "Dockerfile"), "utf8")
      .split("\n")
      .filter((line) => /^FROM\s/i.test(line));
    expect(fromLines.length).toBeGreaterThan(0);
    for (const line of fromLines) expect(line).toMatch(/@sha256:[0-9a-f]{64}/);
  });

  it.each(services)("%s switches to a non-root user", (service) => {
    const users = readFileSync(join("src", service, "Dockerfile"), "utf8")
      .split("\n")
      .filter((line) => /^USER\s/i.test(line))
      .map((line) => line.replace(/^USER\s+/i, "").trim());
    expect(users.length).toBeGreaterThan(0);
    expect(["root", "0"]).not.toContain(users.at(-1)?.split(":")[0]);
  });

  it.each(services)("%s has a Dependabot docker entry", (service) => {
    expect(dockerDirectories).toContain(`/src/${service}`);
  });
});
