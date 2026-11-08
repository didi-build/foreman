import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeToken } from "../.github/scripts/bootstrap-common.mjs";
import {
  bootstrapCollectsPersonalData,
  deriveBootstrapPlan,
  deriveInitArgs,
  deriveProjectOwner,
  deriveSlug,
  isInitialized,
  MISSING_REPOSITORY_DESCRIPTION_MESSAGE,
  planNeedsToken,
  resolveBootstrapRepositoryDescription,
  resolveTokenPolicy,
  shouldExecuteBootstrap,
  validateCollectsPersonalDataEnv,
} from "../.github/scripts/bootstrap-plan.mjs";

const initScript = join(
  fileURLToPath(new URL("..", import.meta.url)),
  "scripts/init-project.mjs",
);

describe("bootstrap lib (unit)", () => {
  it("isInitialized is false only when README.project.md exists and launchpadTemplate is true", () => {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-init-"));
    writeFileSync(join(dir, "README.project.md"), "# template\n");
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ launchpadTemplate: true }, null, 2)}\n`,
    );
    expect(isInitialized(dir)).toBe(false);

    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "x" }, null, 2)}\n`,
    );
    expect(isInitialized(dir)).toBe(true);
  });

  it("deriveBootstrapPlan covers init, noop push, and retry/dispatch settings", () => {
    expect(
      deriveBootstrapPlan({ initialized: false, event: "push", runAttempt: 1 }),
    ).toEqual({
      init: true,
      settings: true,
    });
    expect(
      deriveBootstrapPlan({ initialized: true, event: "push", runAttempt: 1 }),
    ).toEqual({ init: false, settings: false });
    expect(
      deriveBootstrapPlan({
        initialized: true,
        event: "workflow_dispatch",
        runAttempt: 1,
      }),
    ).toEqual({ init: false, settings: true });
    expect(
      deriveBootstrapPlan({ initialized: true, event: "push", runAttempt: 2 }),
    ).toEqual({
      init: false,
      settings: true,
    });
  });

  it("resolveTokenPolicy handles org token expectations", () => {
    expect(
      resolveTokenPolicy({
        planNeedsToken: false,
        hasToken: false,
        repositoryOwner: "didi-build",
      }),
    ).toBe("ok");
    expect(
      resolveTokenPolicy({
        planNeedsToken: true,
        hasToken: true,
        repositoryOwner: "other-org",
      }),
    ).toBe("ok");
    expect(
      resolveTokenPolicy({
        planNeedsToken: true,
        hasToken: false,
        repositoryOwner: "didi-build",
      }),
    ).toBe("fail");
    expect(
      resolveTokenPolicy({
        planNeedsToken: true,
        hasToken: false,
        repositoryOwner: "other-org",
      }),
    ).toBe("warn-skip");
  });

  it("deriveSlug normalizes repository names", () => {
    expect(deriveSlug("my_cool_app")).toBe("my-cool-app");
    expect(deriveSlug("We.Met")).toBe("we-met");
    expect(deriveSlug("UPPERCASE")).toBe("uppercase");
    expect(deriveSlug("")).toBe("project");
    expect(deriveSlug("--hello--world--")).toBe("hello-world");
  });

  it("deriveProjectOwner maps didi-build and passes through other logins", () => {
    expect(deriveProjectOwner("didi-build")).toBe("Didi Build");
    expect(deriveProjectOwner("acme-corp")).toBe("acme-corp");
  });

  it("deriveInitArgs builds the display name, the purpose from the description, and the owner from the login", () => {
    expect(
      deriveInitArgs({
        repoName: "my_cool_app",
        description: "  Purpose line  ",
        repositoryOwnerLogin: "didi-build",
      }),
    ).toEqual({
      slug: "my-cool-app",
      displayName: "My Cool App",
      purpose: "Purpose line",
      owner: "Didi Build",
    });
    expect(
      deriveInitArgs({
        repoName: "app",
        description: "Purpose line",
        repositoryOwnerLogin: "my-github-user",
      }).owner,
    ).toBe("my-github-user");
  });

  it("deriveInitArgs rejects a missing description: init needs it as the purpose", () => {
    for (const description of ["", "   ", null, undefined]) {
      expect(() => deriveInitArgs({ repoName: "app", description })).toThrow(
        MISSING_REPOSITORY_DESCRIPTION_MESSAGE,
      );
    }
  });

  it("resolveBootstrapRepositoryDescription requires a non-empty description", () => {
    for (const description of ["", "   ", null, undefined]) {
      expect(resolveBootstrapRepositoryDescription(description)).toEqual({
        ok: false,
        message: MISSING_REPOSITORY_DESCRIPTION_MESSAGE,
      });
    }
    expect(resolveBootstrapRepositoryDescription("  Real purpose  ")).toEqual({
      ok: true,
      purpose: "Real purpose",
    });
  });

  it("sanitizeToken trims edges and rejects embedded control characters", () => {
    expect(sanitizeToken("ghp_clean_token")).toEqual({
      token: "ghp_clean_token",
      trimmed: false,
      valid: true,
    });
    expect(sanitizeToken("ghp_clean_token\n")).toEqual({
      token: "ghp_clean_token",
      trimmed: true,
      valid: true,
    });
    expect(sanitizeToken("ghp_clean_token\r\n")).toEqual({
      token: "ghp_clean_token",
      trimmed: true,
      valid: true,
    });
    expect(sanitizeToken(" ghp_clean_token")).toEqual({
      token: "ghp_clean_token",
      trimmed: true,
      valid: true,
    });
    expect(sanitizeToken("ghp_bad\ninner")).toEqual({
      token: "ghp_bad\ninner",
      trimmed: false,
      valid: false,
    });
    expect(sanitizeToken("")).toEqual({
      token: "",
      trimmed: false,
      valid: false,
    });
  });

  it("personal data is on unless the variable turns it off (D-359), and a bad value is refused", () => {
    expect(bootstrapCollectsPersonalData(undefined)).toBe(true);
    expect(bootstrapCollectsPersonalData("")).toBe(true);
    expect(bootstrapCollectsPersonalData("false")).toBe(false);
    expect(bootstrapCollectsPersonalData("no")).toBe(false);
    expect(validateCollectsPersonalDataEnv("maybe")).toEqual({
      ok: false,
      message:
        "Invalid LAUNCHPAD_COLLECTS_PERSONAL_DATA: use true/false, yes/no, or 1/0.",
    });
    expect(validateCollectsPersonalDataEnv(undefined)).toEqual({ ok: true });
  });

  it("shouldExecuteBootstrap respects token policy", () => {
    const plan = { init: true, settings: true };
    expect(shouldExecuteBootstrap({ plan, tokenPolicy: "ok" })).toBe(true);
    expect(shouldExecuteBootstrap({ plan, tokenPolicy: "fail" })).toBe(false);
    expect(shouldExecuteBootstrap({ plan, tokenPolicy: "warn-skip" })).toBe(false);
    expect(planNeedsToken({ init: false, settings: false })).toBe(false);
  });
});

describe("init-project shell-safe purpose (unit)", () => {
  function seedLaunchpadDir(root: string) {
    writeFileSync(
      join(root, "README.project.md"),
      "# {{PROJECT_NAME}}\n\n{{PROJECT_PURPOSE}}\n",
    );
    writeFileSync(join(root, "LICENSE.project"), "Copyright {{PROJECT_OWNER}}\n");
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "launchpad", launchpadTemplate: true, license: "MIT" }, null, 2)}\n`,
    );
    mkdirSync(join(root, "docs"), { recursive: true });
  }

  it("handles quotes, backticks, command substitution, and newlines in purpose", () => {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-shell-"));
    seedLaunchpadDir(dir);
    const purpose = 'Say "hi" `bye` $(rm -rf /)\nsecond line';
    const env = { ...process.env };
    delete env.LAUNCHPAD_COLLECTS_PERSONAL_DATA;
    execFileSync(
      "node",
      [initScript, "safe-app", "Safe App", purpose, "Owner", "--no-personal-data"],
      {
        cwd: dir,
        encoding: "utf8",
        env,
      },
    );
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain(purpose);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("safe-app");
    expect(existsSync(join(dir, "README.project.md"))).toBe(false);
  });
});
