import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const bootstrapScript = join(root, "scripts/bootstrap.mjs");

function parseGithubOutput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function seedTemplateState(dir: string) {
  writeFileSync(join(dir, "README.project.md"), "# template\n");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "launchpad", launchpadTemplate: true }, null, 2)}\n`,
  );
}

function seedInitializedState(dir: string) {
  seedTemplateState(dir);
  rmSync(join(dir, "README.project.md"));
}

type PlanCase = {
  name: string;
  seed: "template" | "initialized";
  env: Record<string, string>;
  expectStatus: number;
  expectOutput: Partial<Record<string, string>>;
  stdoutIncludes?: string;
};

function runPlan(dir: string, env: Record<string, string>) {
  const outputPath = join(dir, "github-output");
  writeFileSync(outputPath, "");
  const result = spawnSync(process.execPath, [bootstrapScript, "plan"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      ...env,
    },
  });
  const output = parseGithubOutput(readFileSync(outputPath, "utf8"));
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output,
  };
}

const templateDescription = "Example repository for bootstrap tests";

const templateCases: PlanCase[] = [
  {
    name: "didi-build push attempt 1 with invalid LAUNCHPAD_COLLECTS_PERSONAL_DATA",
    seed: "template",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: templateDescription,
      LAUNCHPAD_COLLECTS_PERSONAL_DATA: "maybe",
    },
    expectStatus: 1,
    expectOutput: {},
    stdoutIncludes: "Invalid LAUNCHPAD_COLLECTS_PERSONAL_DATA",
  },
  {
    name: "didi-build push attempt 1 with token",
    seed: "template",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: templateDescription,
    },
    expectStatus: 0,
    expectOutput: {
      init: "true",
      settings: "true",
      execute: "true",
    },
  },
  {
    name: "didi-build push attempt 1 without token",
    seed: "template",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "false",
      LAUNCHPAD_REPO_DESCRIPTION: templateDescription,
    },
    expectStatus: 1,
    expectOutput: {
      token_policy: "fail",
      execute: "false",
    },
  },
  {
    name: "didi-build push attempt 1 without token and empty repository description",
    seed: "template",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "false",
      LAUNCHPAD_REPO_DESCRIPTION: "",
    },
    expectStatus: 1,
    expectOutput: {
      token_policy: "fail",
      execute: "false",
    },
    stdoutIncludes: "BOOTSTRAP_TOKEN is required for didi-build",
  },
  {
    name: "template init needed with empty repository description",
    seed: "template",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: "",
    },
    expectStatus: 1,
    expectOutput: {},
    stdoutIncludes: "This repository has no description",
  },
  {
    name: "template init needed with whitespace-only repository description",
    seed: "template",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: "   ",
    },
    expectStatus: 1,
    expectOutput: {},
    stdoutIncludes: "This repository has no description",
  },
  {
    name: "other owner push attempt 1 without token",
    seed: "template",
    env: {
      GITHUB_REPOSITORY: "acme-corp/my-repo",
      GITHUB_REPOSITORY_OWNER: "acme-corp",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "false",
      LAUNCHPAD_REPO_DESCRIPTION: templateDescription,
    },
    expectStatus: 0,
    expectOutput: {
      token_policy: "warn-skip",
      execute: "false",
    },
    stdoutIncludes: "::warning",
  },
  {
    name: "other owner push attempt 1 without token and empty repository description",
    seed: "template",
    env: {
      GITHUB_REPOSITORY: "acme-corp/my-repo",
      GITHUB_REPOSITORY_OWNER: "acme-corp",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "false",
      LAUNCHPAD_REPO_DESCRIPTION: "",
    },
    expectStatus: 0,
    expectOutput: {
      token_policy: "warn-skip",
      execute: "false",
    },
    stdoutIncludes: "Bootstrap skipped: no BOOTSTRAP_TOKEN repository secret",
  },
];

const initializedCases: PlanCase[] = [
  {
    name: "initialized push attempt 1 with token",
    seed: "initialized",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "true",
    },
    expectStatus: 0,
    expectOutput: {
      init: "false",
      settings: "false",
      needs_token: "false",
      execute: "false",
    },
  },
  {
    name: "initialized push attempt 1 without token",
    seed: "initialized",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "false",
    },
    expectStatus: 0,
    expectOutput: {
      execute: "false",
    },
  },
  {
    name: "initialized workflow_dispatch with token",
    seed: "initialized",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "true",
    },
    expectStatus: 0,
    expectOutput: {
      settings: "true",
      execute: "true",
    },
  },
  {
    name: "initialized repo with empty repository description",
    seed: "initialized",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "true",
      LAUNCHPAD_REPO_DESCRIPTION: "",
    },
    expectStatus: 0,
    expectOutput: {
      init: "false",
      settings: "false",
      execute: "false",
    },
  },
  {
    name: "initialized push attempt 2 with token",
    seed: "initialized",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "2",
      HAS_BOOTSTRAP_TOKEN: "true",
    },
    expectStatus: 0,
    expectOutput: {
      settings: "true",
      execute: "true",
    },
  },
  {
    name: "initialized workflow_dispatch didi-build without token",
    seed: "initialized",
    env: {
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "false",
    },
    expectStatus: 1,
    expectOutput: {
      token_policy: "fail",
    },
  },
  {
    name: "initialized workflow_dispatch other owner without token",
    seed: "initialized",
    env: {
      GITHUB_REPOSITORY: "acme-corp/my-repo",
      GITHUB_REPOSITORY_OWNER: "acme-corp",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "false",
    },
    expectStatus: 0,
    expectOutput: {
      token_policy: "warn-skip",
    },
  },
];

function installFakeNpm(dir: string) {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const npmPath = join(bin, "npm");
  writeFileSync(
    npmPath,
    `#!/bin/sh
echo "fake-npm-invoked"
exit 1
`,
  );
  chmodSync(npmPath, 0o755);
  return bin;
}

function runBootstrapRun(
  dir: string,
  env: Record<string, string>,
  options: { fakeNpm?: boolean } = {},
) {
  const summaryPath = join(dir, "step-summary.md");
  writeFileSync(summaryPath, "");
  const fakeBin = options.fakeNpm ? installFakeNpm(dir) : "";
  const result = spawnSync(process.execPath, [bootstrapScript, "run"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: summaryPath,
      GITHUB_REPOSITORY: "didi-build/my-repo",
      GITHUB_REPOSITORY_OWNER: "didi-build",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ATTEMPT: "1",
      HAS_BOOTSTRAP_TOKEN: "true",
      PATH: fakeBin ? `${fakeBin}:${process.env.PATH ?? ""}` : process.env.PATH,
      ...env,
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    summary: readFileSync(summaryPath, "utf8"),
  };
}

describe("bootstrap run token sanitization (subprocess)", () => {
  it("rejects tokens with embedded newlines before repo-settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-run-token-"));
    seedInitializedState(dir);

    const result = runBootstrapRun(dir, {
      GH_TOKEN: "ghp_inner\nnewline",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Malformed BOOTSTRAP_TOKEN");
    expect(result.stdout + result.stderr).not.toContain("fake-npm-invoked");
    expect(result.summary).toContain("malformed");
  });

  it("rejects an empty GH_TOKEN before repo-settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-run-token-"));
    seedInitializedState(dir);

    const result = runBootstrapRun(dir, {
      GH_TOKEN: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Malformed BOOTSTRAP_TOKEN");
    expect(result.stdout + result.stderr).not.toContain("fake-npm-invoked");
  });

  it("warns on trimmed tokens and passes the sanitized value to repo-settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-run-token-"));
    seedInitializedState(dir);

    const result = runBootstrapRun(
      dir,
      {
        GH_TOKEN: "ghp_trimmed_value\n",
      },
      { fakeNpm: true },
    );

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("::warning");
    expect(result.stdout + result.stderr).toContain("trimmed");
    expect(result.stdout + result.stderr).toContain("fake-npm-invoked");
    expect(result.summary).toContain("repo-settings");
  });
});

describe("bootstrap plan CLI (subprocess)", () => {
  for (const case_ of [...templateCases, ...initializedCases]) {
    it(case_.name, () => {
      const dir = mkdtempSync(join(tmpdir(), "bootstrap-plan-"));
      if (case_.seed === "template") {
        seedTemplateState(dir);
      } else {
        seedInitializedState(dir);
      }

      const result = runPlan(dir, case_.env);
      expect(result.status).toBe(case_.expectStatus);
      for (const [key, value] of Object.entries(case_.expectOutput)) {
        expect(result.output[key], `GITHUB_OUTPUT ${key}`).toBe(value);
      }
      if (case_.stdoutIncludes) {
        expect(result.stdout + result.stderr).toContain(case_.stdoutIncludes);
      }
    });
  }
});
