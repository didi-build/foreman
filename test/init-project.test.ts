import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const initScript = join(
  fileURLToPath(new URL("..", import.meta.url)),
  "scripts/init-project.mjs",
);

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

const LAUNCHPAD_MIT_SNAPSHOT = "MIT snapshot for attribution check\n";

function initEnv(extra: Record<string, string | undefined> = {}) {
  const env = { ...process.env };
  delete env.LAUNCHPAD_COLLECTS_PERSONAL_DATA;
  return { ...env, ...extra };
}

function runInit(
  dir: string,
  args: string[],
  options: { env?: Record<string, string | undefined> } = {},
) {
  return execFileSync("node", [initScript, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: initEnv(options.env),
  });
}

function runInitFails(
  dir: string,
  args: string[],
  options: { env?: Record<string, string | undefined> } = {},
) {
  let status: number | undefined;
  try {
    execFileSync("node", [initScript, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: initEnv(options.env),
    });
  } catch (err) {
    status = (err as { status?: number }).status;
  }
  expect(status).toBeGreaterThan(0);
}

function linkWorkspaceNodeModules(dir: string) {
  symlinkSync(
    join(workspaceRoot, "node_modules"),
    join(dir, "node_modules"),
    "junction",
  );
}

function seedLaunchpadDir(root: string) {
  writeFileSync(
    join(root, "README.project.md"),
    "# {{PROJECT_NAME}}\n\n{{PROJECT_PURPOSE}}\n\n<!-- launchpad-attribution:start -->\n<!-- launchpad-attribution:end -->\n",
  );
  writeFileSync(
    join(root, "LICENSE.project"),
    "Copyright (c) {{PROJECT_YEAR}} {{PROJECT_OWNER}}. All rights reserved.\n",
  );
  mkdirSync(join(root, "LICENSES"), { recursive: true });
  writeFileSync(join(root, "LICENSES/launchpad-MIT.txt"), LAUNCHPAD_MIT_SNAPSHOT);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "launchpad", launchpadTemplate: true, license: "MIT", description: "template" }, null, 2)}\n`,
  );
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/greet.ts"), "export function greet() {}\n");
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(
    join(root, "test/greet.test.ts"),
    "import { greet } from '../src/greet.js';\n",
  );
  writeFileSync(
    join(root, "wrangler.jsonc"),
    '{"name":"launchpad","compatibility_date":"2026-10-26"}\n',
  );
}

describe("init-project (unit)", () => {
  it("leaves templates untouched when wrangler name is not launchpad", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      '{"name":"wrong-name","compatibility_date":"2026-10-26"}\n',
    );
    const pkgBefore = readFileSync(join(dir, "package.json"));
    const readmeBefore = readFileSync(join(dir, "README.project.md"));
    const licenseBefore = readFileSync(join(dir, "LICENSE.project"));
    const wranglerBefore = readFileSync(join(dir, "wrangler.jsonc"));
    runInitFails(dir, ["my-app", "My App", "--no-personal-data"]);
    expect(readFileSync(join(dir, "package.json"))).toEqual(pkgBefore);
    expect(readFileSync(join(dir, "README.project.md"))).toEqual(readmeBefore);
    expect(readFileSync(join(dir, "LICENSE.project"))).toEqual(licenseBefore);
    expect(readFileSync(join(dir, "wrangler.jsonc"))).toEqual(wranglerBefore);
    expect(existsSync(join(dir, "README.md"))).toBe(false);
  });

  it("rejects invalid worker slugs before moving templates", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    let stderr = "";
    try {
      execFileSync("node", [initScript, "Bad_Slug", "Bad Slug", "--no-personal-data"], {
        cwd: dir,
        encoding: "utf8",
        env: initEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { stderr?: string; status?: number };
      stderr = e.stderr ?? "";
      expect(e.status).toBeGreaterThan(0);
    }
    expect(stderr).toMatch(/lowercase letters, digits, and dashes/i);
    expect(existsSync(join(dir, "README.project.md"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(false);
  });

  it("does not move templates when args are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    runInitFails(dir, []);
    expect(existsSync(join(dir, "README.project.md"))).toBe(true);
    expect(existsSync(join(dir, "LICENSE.project"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(false);
  });

  it("does not move templates when LICENSE.project is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    writeFileSync(
      join(dir, "README.project.md"),
      "# {{PROJECT_NAME}}\n\n{{PROJECT_PURPOSE}}\n",
    );
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ launchpadTemplate: true }, null, 2)}\n`,
    );
    runInitFails(dir, ["x", "X"]);
    expect(existsSync(join(dir, "README.project.md"))).toBe(true);
  });

  it("moves README and LICENSE templates on success", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    runInit(dir, ["my-app", "My App", "Purpose", "Acme Corp", "--no-personal-data"]);
    expect(existsSync(join(dir, "README.project.md"))).toBe(false);
    expect(existsSync(join(dir, "LICENSE.project"))).toBe(false);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("# My App");
    expect(readme).toContain("Purpose");
    expect(readme).toContain("<!-- launchpad-attribution:start -->");
    const license = readFileSync(join(dir, "LICENSE"), "utf8");
    expect(license).toContain("Acme Corp");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.license).toBe("UNLICENSED");
    expect(pkg.description).toBe("Purpose");
    expect(pkg.launchpadTemplate).toBeUndefined();
    expect(existsSync(join(dir, "src/greet.ts"))).toBe(false);
    expect(existsSync(join(dir, "test/greet.test.ts"))).toBe(false);
    expect(existsSync(join(dir, "src/.gitkeep"))).toBe(true);
    expect(readFileSync(join(dir, "LICENSES/launchpad-MIT.txt"), "utf8")).toBe(
      LAUNCHPAD_MIT_SNAPSHOT,
    );
    expect(existsSync(join(dir, ".nodrift/manifest.json"))).toBe(false);
    expect(existsSync(join(dir, "docs/privacy"))).toBe(false);
    const wranglerRaw = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
    expect(wranglerRaw).not.toContain('"launchpad"');
    const wrangler = JSON.parse(wranglerRaw) as { name: string };
    expect(wrangler.name).toBe("my-app");
  });

  it("does not create nodrift scaffolding with --no-personal-data", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    linkWorkspaceNodeModules(dir);
    runInit(dir, ["my-app", "My App", "Purpose", "Acme Corp", "--no-personal-data"]);
    expect(existsSync(join(dir, ".nodrift/manifest.json"))).toBe(false);
    expect(existsSync(join(dir, "docs/privacy/data-map.yml"))).toBe(false);
  });

  it("does not create nodrift scaffolding when env is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    linkWorkspaceNodeModules(dir);
    runInit(dir, ["my-app", "My App", "Purpose", "Acme Corp"], {
      env: { LAUNCHPAD_COLLECTS_PERSONAL_DATA: "false" },
    });
    expect(existsSync(join(dir, ".nodrift/manifest.json"))).toBe(false);
  });

  it("runs nodrift init when --personal-data is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    linkWorkspaceNodeModules(dir);
    runInit(dir, ["my-app", "My App", "Purpose", "Acme Corp", "--personal-data"]);
    expect(existsSync(join(dir, ".nodrift/manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "docs/privacy/data-map.yml"))).toBe(true);
  });

  it("runs nodrift init when env is true only", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    linkWorkspaceNodeModules(dir);
    runInit(dir, ["my-app", "My App", "Purpose", "Acme Corp"], {
      env: { LAUNCHPAD_COLLECTS_PERSONAL_DATA: "true" },
    });
    expect(existsSync(join(dir, ".nodrift/manifest.json"))).toBe(true);
  });

  it("leaves templates when env is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    runInitFails(dir, ["my-app", "My App"], {
      env: { LAUNCHPAD_COLLECTS_PERSONAL_DATA: "maybe" },
    });
    expect(existsSync(join(dir, "README.project.md"))).toBe(true);
    expect(existsSync(join(dir, "LICENSE.project"))).toBe(true);
  });

  it("leaves templates when personal-data flags conflict", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    runInitFails(dir, ["my-app", "My App", "--personal-data", "--no-personal-data"]);
    expect(existsSync(join(dir, "README.project.md"))).toBe(true);
  });

  it("preflights nodrift before writing when --personal-data and kit is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    runInitFails(dir, ["my-app", "My App", "--personal-data"]);
    expect(existsSync(join(dir, "README.project.md"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(false);
  });

  it("fails non-interactively without personal data answer before writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    let stderr = "";
    try {
      execFileSync("node", [initScript, "my-app", "My App"], {
        cwd: dir,
        encoding: "utf8",
        env: initEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { stderr?: string };
      stderr = e.stderr ?? "";
    }
    expect(stderr).toContain("--personal-data");
    expect(stderr).toContain("LAUNCHPAD_COLLECTS_PERSONAL_DATA");
    expect(existsSync(join(dir, "README.project.md"))).toBe(true);
  });

  it("does not clobber README on re-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchpad-init-"));
    seedLaunchpadDir(dir);
    runInit(dir, ["my-app", "My App", "--no-personal-data"]);
    writeFileSync(join(dir, "README.md"), "# Custom README\n");
    runInitFails(dir, ["my-app", "My App"]);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# Custom README\n");
  });
});

function isLaunchpadTemplateRepo() {
  try {
    return JSON.parse(readFileSync("package.json", "utf8")).launchpadTemplate === true;
  } catch {
    return false;
  }
}

describe.skipIf(!isLaunchpadTemplateRepo())("Launchpad template license (unit)", () => {
  it("template repo is MIT-licensed", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.license).toBe("MIT");
    expect(readFileSync("LICENSE", "utf8")).toContain("Copyright (c) 2026 Didi Build");
  });
});
