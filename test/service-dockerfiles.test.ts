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
  ignore?: { "dependency-name": string; "update-types"?: string[] }[];
}
const dependabot = parse(readFileSync(".github/dependabot.yml", "utf8")) as {
  updates: DependabotUpdate[];
};
const dockerUpdates = dependabot.updates.filter(
  (update) => update["package-ecosystem"] === "docker",
);
const dockerDirectories = dockerUpdates.flatMap(
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

  it.each(services)(
    "%s copies every repository module its code imports as a value",
    (service) => {
      // A service starts with Node's type stripping, so a value import of a file its Dockerfile
      // does not copy crashes it at start (the bundle files reader, O-121, is one such file).
      // `import type` lines are erased and may point anywhere.
      const copied = readFileSync(join("src", service, "Dockerfile"), "utf8")
        .split("\n")
        .filter((line) => /^COPY\s/i.test(line))
        .map((line) => line.split(/\s+/).at(-2) ?? "")
        .filter((source) => source.startsWith("src/"));
      const files = readdirSync(join("src", service), {
        recursive: true,
        encoding: "utf8",
      })
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .map((file) => join("src", service, file));
      const seen = new Set<string>();
      const visit = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(
          /^(?:import|export)\s+(?!type\s)[^;]*?from\s+"(\.[^"]+)";/gms,
        )) {
          const target = join(file, "..", match[1] ?? "");
          expect(
            copied.some(
              (source) => target === source || target.startsWith(`${source}/`),
            ),
            `${file} imports ${target}, which the ${service} Dockerfile does not copy`,
          ).toBe(true);
          visit(target);
        }
      };
      files.forEach(visit);
      expect(seen.size).toBeGreaterThan(0);
    },
  );

  it("keeps every Dependabot docker entry off major base-image upgrades", () => {
    for (const update of dockerUpdates) {
      expect(
        update.ignore?.some(
          (rule) =>
            rule["dependency-name"] === "*" &&
            rule["update-types"]?.includes("version-update:semver-major"),
        ),
        `${update.directory ?? update.directories?.join(", ")} must ignore major updates`,
      ).toBe(true);
    }
  });
});
