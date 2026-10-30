import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Agent images are jobs, not services (ADR 0106 section 4): ADR 0111's digest pin, non-root
// user and Dependabot entry hold, and they declare no port and no health check. The services
// guard (service-dockerfiles.test.ts) covers src/*/Dockerfile; agent images sit one level down.

const ROOT = join("src", "agent-images");
const images = readdirSync(ROOT, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(join(ROOT, entry.name, "Dockerfile")),
  )
  .map((entry) => entry.name);

const dockerfile = (image: string) =>
  readFileSync(join(ROOT, image, "Dockerfile"), "utf8");
const instructions = (image: string, keyword: string) =>
  dockerfile(image)
    .split("\n")
    .filter((line) => new RegExp(`^${keyword}\\s`, "i").test(line));

interface DependabotUpdate {
  "package-ecosystem": string;
  directory?: string;
  ignore?: { "dependency-name": string; "update-types"?: string[] }[];
}
const updates = (
  parse(readFileSync(".github/dependabot.yml", "utf8")) as {
    updates: DependabotUpdate[];
  }
).updates;
const entry = (ecosystem: string, directory: string) =>
  updates.find(
    (u) => u["package-ecosystem"] === ecosystem && u.directory === directory,
  );
const ignoresMajor = (update: DependabotUpdate | undefined) =>
  update?.ignore?.some(
    (rule) =>
      rule["dependency-name"] === "*" &&
      rule["update-types"]?.includes("version-update:semver-major"),
  ) ?? false;

describe("agent image Dockerfiles (unit: job image conventions, ADR 0106 section 4)", () => {
  it("finds both agent images, so the checks below cannot pass on an empty list", () => {
    expect(images.sort()).toEqual(["claude-api", "claude-code"]);
  });

  it.each(images)("%s pins every base image by digest", (image) => {
    const from = instructions(image, "FROM");
    expect(from.length).toBeGreaterThan(0);
    for (const line of from) expect(line).toMatch(/@sha256:[0-9a-f]{64}/);
  });

  it.each(images)("%s switches to a non-root user", (image) => {
    const users = instructions(image, "USER").map((line) =>
      line.replace(/^USER\s+/i, "").trim(),
    );
    expect(users.length).toBeGreaterThan(0);
    expect(["root", "0"]).not.toContain(users.at(-1)?.split(":")[0]);
  });

  it.each(images)(
    "%s is a job: no PORT, no EXPOSE, no HEALTHCHECK, no /health",
    (image) => {
      const text = dockerfile(image);
      expect(instructions(image, "EXPOSE")).toEqual([]);
      expect(instructions(image, "HEALTHCHECK")).toEqual([]);
      expect(text).not.toMatch(/\bPORT\b/);
      expect(text).not.toMatch(/\/health\b/);
      expect(instructions(image, "CMD").at(-1)).toBe(
        `CMD ["node", "src/agent-images/${image}/main.ts"]`,
      );
    },
  );

  it.each(images)(
    "%s has a Dependabot docker entry that ignores major upgrades",
    (image) => {
      const update = entry("docker", `/src/agent-images/${image}`);
      expect(update).toBeDefined();
      expect(ignoresMajor(update)).toBe(true);
    },
  );

  it("pins the Claude Code CLI to an exact version in the image only, tracked by Dependabot", () => {
    const cli = JSON.parse(
      readFileSync(join(ROOT, "claude-code", "cli", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(cli.dependencies)).toEqual(["@anthropic-ai/claude-code"]);
    expect(cli.dependencies["@anthropic-ai/claude-code"]).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(
      readFileSync(join(ROOT, "claude-code", "cli", "package-lock.json"), "utf8"),
    ) as { packages: Record<string, { version?: string }> };
    expect(lock.packages["node_modules/@anthropic-ai/claude-code"]?.version).toBe(
      cli.dependencies["@anthropic-ai/claude-code"],
    );
    const root = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(root.dependencies["@anthropic-ai/claude-code"]).toBeUndefined();
    expect(root.devDependencies["@anthropic-ai/claude-code"]).toBeUndefined();
    expect(dockerfile("claude-code")).toContain(
      "npm ci --prefix /opt/claude-code --omit=dev",
    );
    expect(ignoresMajor(entry("npm", "/src/agent-images/claude-code/cli"))).toBe(true);
  });

  it("calls the CLI by its installed path", () => {
    expect(dockerfile("claude-code")).toContain(
      "ENV FOREMAN_CLAUDE_CLI=/opt/claude-code/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    );
  });

  it("is built and checked in CI by the agent container script", () => {
    const workflow = readFileSync(".github/workflows/containers.yml", "utf8");
    expect(workflow).toContain("src/agent-images/*/Dockerfile");
    expect(workflow).toContain("scripts/check-agent-container.sh");
  });
});
