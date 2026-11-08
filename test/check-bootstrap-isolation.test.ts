// Unit and integration: the bootstrap isolation check, `.github/scripts/check-bootstrap-isolation.mjs`,
// and its YAML reader (D-358 lock 1, O-113). It passes on the real files and fails on each
// violation: every fixture is a copy of the real .github/ workflows and scripts with one change.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  checkBootstrapIsolation,
  checkCommands,
} from "../.github/scripts/check-bootstrap-isolation.mjs";
import { parseWorkflowYaml } from "../.github/scripts/workflow-yaml.mjs";
import { DEFAULT_PRIVILEGED_PATHS, globToRegExp } from "../src/core/guards/review.ts";
import { repoRoot, tempDir } from "./bootstrap-fixture.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** A copy of the real .github/workflows and .github/scripts. */
function fixture() {
  const root = tempDir("bootstrap-isolation-");
  roots.push(root);
  mkdirSync(join(root, ".github"), { recursive: true });
  cpSync(join(repoRoot, ".github/workflows"), join(root, ".github/workflows"), {
    recursive: true,
  });
  cpSync(join(repoRoot, ".github/scripts"), join(root, ".github/scripts"), {
    recursive: true,
  });
  return root;
}

/** Replaces one exact piece of a fixture file; fails if it is not there, so no case is empty. */
function change(root: string, path: string, from: string, to: string) {
  const file = join(root, path);
  const before = readFileSync(file, "utf8");
  expect(before.includes(from), `${path} contains ${JSON.stringify(from)}`).toBe(true);
  writeFileSync(file, before.replace(from, to));
}

const BOOTSTRAP = ".github/workflows/bootstrap.yml";
const PUSH_RUN = "        run: node .github/scripts/bootstrap-push.mjs\n";
const SETTINGS_RUN =
  '        run: node .github/scripts/bootstrap-settings.mjs --apply --verify "$DEFAULT_BRANCH"\n';
const APPLY_CHECKOUT = `      - name: Checkout the commit the decision read (read-only)
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          ref: \${{ needs.decide.outputs.sha }}
          persist-credentials: false

      - name: Fetch the patch`;

const violations = (root: string) => checkBootstrapIsolation(root).violations;

describe("the workflow YAML reader (unit)", () => {
  const normalize = (value: unknown): unknown =>
    value === null
      ? null
      : Array.isArray(value)
        ? value.map(normalize)
        : typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(([k, v]) => [
                k,
                normalize(v),
              ]),
            )
          : String(value);

  it("reads every workflow in the repository exactly as the yaml package does, scalars as strings", () => {
    const names = readdirSync(join(repoRoot, ".github/workflows"));
    expect(names).toContain("bootstrap.yml");
    for (const name of names) {
      const source = readFileSync(join(repoRoot, ".github/workflows", name), "utf8");
      expect(parseWorkflowYaml(source), name).toEqual(normalize(parseYaml(source)));
    }
  });

  it("reads block scalars, folded scalars, quoted scalars, flow sequences and empty values", () => {
    const source = [
      "a: |",
      "  one",
      "    two",
      "",
      "b: >-",
      "  x &&",
      "  y",
      'c: "q: \\"z\\""',
      "d: 'it''s'",
      "e: [main, dev]",
      "f:",
      "g: {}",
      "h: plain # comment",
      "i: |-",
      "  kept",
      "",
    ].join("\n");
    const expected = {
      a: "one\n  two\n",
      b: "x && y",
      c: 'q: "z"',
      d: "it's",
      e: ["main", "dev"],
      f: null,
      g: {},
      h: "plain",
      i: "kept",
    };
    expect(parseWorkflowYaml(source)).toEqual(expected);
    expect(normalize(parseYaml(source))).toEqual(expected);
  });

  it("refuses what it does not read, so the check fails closed", () => {
    for (const source of [
      "a: &x 1\nb: *x\n",
      "a: !!str 1\n",
      "a: {b: c}\n",
      "a: one\n  two\n",
      "a:\n\tb: c\n",
      "---\na: 1\n",
      "a: 1\na: 2\n",
      'a: "open\n',
      "? a\n: b\n",
      "a: b: c\n",
    ]) {
      expect(() => parseWorkflowYaml(source), JSON.stringify(source)).toThrow(
        /^line \d+: /,
      );
    }
    expect(() => parseWorkflowYaml("a: one\n  two\n")).toThrow(
      "line 2: multi-line plain scalars and nested blocks after a value are not read",
    );
    expect(() => parseWorkflowYaml("- a: |\n    x\n  b: c\n")).not.toThrow();
  });
});

describe("the bootstrap isolation check on the real files (integration)", () => {
  it("passes, reading every script the workflow runs and the check itself", () => {
    const { violations: found, scripts } = checkBootstrapIsolation(repoRoot);
    expect(found).toEqual([]);
    expect(scripts.sort()).toEqual([
      ".github/scripts/bootstrap-commit.mjs",
      ".github/scripts/bootstrap-common.mjs",
      ".github/scripts/bootstrap-plan.mjs",
      ".github/scripts/bootstrap-push.mjs",
      ".github/scripts/bootstrap-settings.mjs",
      ".github/scripts/check-bootstrap-isolation.mjs",
      ".github/scripts/workflow-yaml.mjs",
    ]);
  });

  it("exits 0 as CI runs it, and 1 with the reasons on a violation", () => {
    const ok = spawnSync(
      process.execPath,
      [".github/scripts/check-bootstrap-isolation.mjs"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("Bootstrap isolation check passed");

    const root = fixture();
    change(root, BOOTSTRAP, PUSH_RUN, "        run: npm run push\n");
    const bad = spawnSync(
      process.execPath,
      [join(root, ".github/scripts/check-bootstrap-isolation.mjs")],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("runs npm or npx");
  });

  it("keeps every script it checks on a privileged path, so the runner never merges a change alone", () => {
    const patterns = DEFAULT_PRIVILEGED_PATHS.map(globToRegExp);
    for (const path of checkBootstrapIsolation(repoRoot).scripts) {
      expect(
        patterns.some((re) => re.test(path)),
        path,
      ).toBe(true);
    }
    for (const path of [BOOTSTRAP, ".github/workflows/bootstrap-isolation.yml"]) {
      expect(
        patterns.some((re) => re.test(path)),
        path,
      ).toBe(true);
    }
  });
});

type Violation = {
  name: string;
  edit: (root: string) => void;
  expect: string;
};

const cases: Violation[] = [
  {
    name: "another workflow names BOOTSTRAP_TOKEN",
    edit: (root) =>
      writeFileSync(
        join(root, ".github/workflows/leak.yml"),
        "on: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.BOOTSTRAP_TOKEN }}\n",
      ),
    expect: ".github/workflows/leak.yml: names BOOTSTRAP_TOKEN; only bootstrap.yml may",
  },
  {
    name: "a token step runs npm",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        SETTINGS_RUN,
        "        run: npm run repo-settings -- --apply\n",
      ),
    expect: "runs npm or npx",
  },
  {
    name: "a token step runs npx",
    edit: (root) => change(root, BOOTSTRAP, PUSH_RUN, "        run: npx some-tool\n"),
    expect: "runs npx; only node .github/scripts/..., git and gh may run",
  },
  {
    name: "a token step runs a repository script outside .github/",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        PUSH_RUN,
        "        run: node scripts/bootstrap.mjs run\n",
      ),
    expect: "runs node on something other than a file in .github/scripts/",
  },
  {
    name: "a token step chains another command",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        PUSH_RUN,
        "        run: node .github/scripts/bootstrap-push.mjs && curl https://example.com\n",
      ),
    expect: "chains, redirects or substitutes commands",
  },
  {
    name: "a token step runs another program",
    edit: (root) => change(root, BOOTSTRAP, PUSH_RUN, "        run: bash ./push.sh\n"),
    expect: "runs bash; only node .github/scripts/..., git and gh may run",
  },
  {
    name: "a git line changes git's configuration",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        PUSH_RUN,
        "        run: git -c core.hooksPath=scripts push\n",
      ),
    expect: "changes git's configuration or directory (-c)",
  },
  {
    name: "the job that runs npm receives the token",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        "        run: npm ci --ignore-scripts\n",
        "        env:\n          GH_TOKEN: ${{ secrets.BOOTSTRAP_TOKEN }}\n        run: npm ci --ignore-scripts\n",
      ),
    expect:
      "job prepare step 3 (Install nodrift without lifecycle scripts): runs npm or npx",
  },
  {
    name: "the token is given at job level",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        "    needs: [decide, prepare]\n",
        "    needs: [decide, prepare]\n    env:\n      GH_TOKEN: ${{ secrets.BOOTSTRAP_TOKEN }}\n",
      ),
    expect: "job apply: names BOOTSTRAP_TOKEN in the job's env; only a step's env may",
  },
  {
    name: "the token is given at workflow level",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        "permissions:\n  contents: read\n\njobs:\n",
        "permissions:\n  contents: read\n\nenv:\n  GH_TOKEN: ${{ secrets.BOOTSTRAP_TOKEN }}\n\njobs:\n",
      ),
    expect: "names BOOTSTRAP_TOKEN in the workflow's env; only a step's env may",
  },
  {
    name: "checkout receives the token as an input",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        APPLY_CHECKOUT,
        APPLY_CHECKOUT.replace(
          "          persist-credentials: false\n",
          "          persist-credentials: false\n          token: ${{ secrets.BOOTSTRAP_TOKEN }}\n",
        ),
      ),
    expect: "names BOOTSTRAP_TOKEN in with; only a step's env may",
  },
  {
    name: "an action step receives the token through its env",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        APPLY_CHECKOUT,
        APPLY_CHECKOUT.replace(
          "        with:\n",
          "        env:\n          GH_TOKEN: ${{ secrets.BOOTSTRAP_TOKEN }}\n        with:\n",
        ),
      ),
    expect: "receives the token but does not run node .github/scripts/..., git or gh",
  },
  {
    name: "checkout persists credentials in the token job",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        APPLY_CHECKOUT,
        APPLY_CHECKOUT.replace(
          "persist-credentials: false",
          "persist-credentials: true",
        ),
      ),
    expect: "checkout persists credentials (set persist-credentials: false)",
  },
  {
    name: "checkout in the token job leaves persist-credentials at its default",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        APPLY_CHECKOUT,
        APPLY_CHECKOUT.replace("          persist-credentials: false\n", ""),
      ),
    expect: "checkout persists credentials (set persist-credentials: false)",
  },
  {
    name: "checkout in the token job reads the triggering ref instead of the decided commit",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        APPLY_CHECKOUT,
        APPLY_CHECKOUT.replace("needs.decide.outputs.sha", "github.ref"),
      ),
    expect: "checkout must read the commit the decide job read",
  },
  {
    name: "the token job has an actions/setup-node cache step",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        APPLY_CHECKOUT,
        `${APPLY_CHECKOUT.replace("      - name: Fetch the patch", "")}      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version-file: .nvmrc\n          cache: npm\n\n      - name: Fetch the patch`,
      ),
    expect: "has an actions/setup-node cache step",
  },
  {
    name: "the token job runs another action",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        APPLY_CHECKOUT,
        `${APPLY_CHECKOUT.replace("      - name: Fetch the patch", "")}      - uses: actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd # v8.0.0\n\n      - name: Fetch the patch`,
      ),
    expect:
      "runs actions/github-script; the token job may run only actions/checkout and actions/download-artifact",
  },
  {
    name: "the token job downloads the patch into the workspace",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        "          path: ${{ runner.temp }}/bootstrap-patch\n",
        "          path: .\n",
      ),
    expect: "download-artifact must download into runner.temp, outside the workspace",
  },
  {
    name: "a token step changes its working directory",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        PUSH_RUN,
        `${PUSH_RUN}        working-directory: scripts\n`,
      ),
    expect: "sets working-directory",
  },
  {
    name: "a token step sets NODE_OPTIONS",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        "          GH_TOKEN: ${{ secrets.BOOTSTRAP_TOKEN }}\n",
        "          GH_TOKEN: ${{ secrets.BOOTSTRAP_TOKEN }}\n          NODE_OPTIONS: --import ./scripts/x.mjs\n",
      ),
    expect: "sets NODE_OPTIONS",
  },
  {
    name: "bootstrap.yml repeats a key, which YAML readers settle differently",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        "    needs: [decide, prepare]\n",
        "    needs: [decide, prepare]\n    runs-on: self-hosted\n",
      ),
    expect: "duplicate or reserved key runs-on",
  },
  {
    name: "every secret is passed at once",
    edit: (root) =>
      change(
        root,
        BOOTSTRAP,
        "          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}\n        run: node .github/scripts/bootstrap-push.mjs",
        "          ALL: ${{ toJSON(secrets) }}\n          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}\n        run: node .github/scripts/bootstrap-push.mjs",
      ),
    expect: "passes every secret at once",
  },
  {
    name: "bootstrap.yml uses YAML the check does not read",
    edit: (root) =>
      change(root, BOOTSTRAP, "  group: bootstrap\n", "  group: &group bootstrap\n"),
    expect: "the check reads only plain workflow YAML",
  },
  {
    name: "a token-job script imports a file outside .github/scripts/",
    edit: (root) =>
      change(
        root,
        ".github/scripts/bootstrap-push.mjs",
        'import { spawnSync } from "node:child_process";\n',
        'import { spawnSync } from "node:child_process";\nimport "../../scripts/lib/bootstrap-token-env.mjs";\n',
      ),
    expect:
      ".github/scripts/bootstrap-push.mjs: imports ../../scripts/lib/bootstrap-token-env.mjs, a file outside .github/scripts/",
  },
  {
    name: "a token-job script imports a package",
    edit: (root) =>
      change(
        root,
        ".github/scripts/bootstrap-settings.mjs",
        "import {\n  appendStepSummary,",
        'import { parse } from "yaml";\nimport {\n  appendStepSummary,',
      ),
    expect:
      ".github/scripts/bootstrap-settings.mjs: imports yaml; only node: built-ins and files under .github/scripts/ may be imported",
  },
  {
    name: "a script reached through another import imports a package",
    edit: (root) => {
      writeFileSync(
        join(root, ".github/scripts/helper.mjs"),
        'export { parse } from "yaml";\n',
      );
      change(
        root,
        ".github/scripts/bootstrap-common.mjs",
        'import { randomUUID } from "node:crypto";\n',
        'import { randomUUID } from "node:crypto";\nimport "./helper.mjs";\n',
      );
    },
    expect: ".github/scripts/helper.mjs: imports yaml",
  },
  {
    name: "the decide step's script imports a bare built-in name",
    edit: (root) =>
      change(
        root,
        ".github/scripts/bootstrap-plan.mjs",
        'import { join } from "node:path";\n',
        'import { join } from "path";\n',
      ),
    expect: ".github/scripts/bootstrap-plan.mjs: imports path; only node: built-ins",
  },
  {
    name: "a script imports a computed module name",
    edit: (root) =>
      change(
        root,
        ".github/scripts/bootstrap-push.mjs",
        "export function runPush(env, cwd) {\n",
        "export async function load(name) {\n  return import(name);\n}\n\nexport function runPush(env, cwd) {\n",
      ),
    expect: "bootstrap-push.mjs: imports a computed module name",
  },
  {
    name: "a script loads code through node:vm",
    edit: (root) =>
      change(
        root,
        ".github/scripts/bootstrap-commit.mjs",
        'import { lstatSync } from "node:fs";\n',
        'import { lstatSync } from "node:fs";\nimport vm from "node:vm";\n',
      ),
    expect: "bootstrap-commit.mjs: imports node:vm, which loads code another way",
  },
  {
    name: "a script starts node instead of git",
    edit: (root) =>
      change(
        root,
        ".github/scripts/bootstrap-push.mjs",
        'const result = spawnSync("git", gitPushArgs(repository, branch), {',
        'const result = spawnSync(process.execPath, ["scripts/push.mjs"], {',
      ),
    expect: "bootstrap-push.mjs: spawnSync starts a program other than git or gh",
  },
  {
    name: "a script starts programs through a shell",
    edit: (root) =>
      change(
        root,
        ".github/scripts/bootstrap-commit.mjs",
        'import { spawnSync } from "node:child_process";\n',
        'import { exec, spawnSync } from "node:child_process";\n',
      ),
    expect:
      "uses exec from node:child_process; only spawnSync and execFileSync may start git or gh",
  },
];

describe("the bootstrap isolation check on violations (integration: fixture copies)", () => {
  it("passes on an unchanged copy, so each case below fails for its own change", () => {
    expect(violations(fixture())).toEqual([]);
  });

  for (const c of cases) {
    it(`fails when ${c.name}`, () => {
      const root = fixture();
      c.edit(root);
      const found = violations(root);
      expect(found.join("\n")).toContain(c.expect);
    });
  }

  it("fails when the token job runs on another runner label", () => {
    const root = fixture();
    const file = join(root, BOOTSTRAP);
    const source = readFileSync(file, "utf8");
    const at = source.indexOf("  apply:");
    writeFileSync(
      file,
      source.slice(0, at) +
        source
          .slice(at)
          .replace("    runs-on: ubuntu-latest\n", "    runs-on: self-hosted\n"),
    );
    expect(violations(root).join("\n")).toContain(
      "must run on a fresh GitHub-hosted runner",
    );
  });

  it("allows the decide step to ask only whether the token is set", () => {
    const root = fixture();
    change(
      root,
      BOOTSTRAP,
      "          HAS_BOOTSTRAP_TOKEN: ${{ secrets.BOOTSTRAP_TOKEN != '' }}\n",
      "          HAS_BOOTSTRAP_TOKEN: ${{ secrets.BOOTSTRAP_TOKEN }}\n",
    );
    // Given the value, the decide job becomes a token job, and its checkout breaks the rules.
    expect(violations(root).join("\n")).toContain(
      "job decide step 1 (Checkout the default branch (read-only)): checkout must read the commit the decide job read",
    );
  });
});

describe("checkCommands (unit)", () => {
  it("accepts node .github/scripts/..., git and gh lines, set -euo pipefail and comments", () => {
    const out: string[] = [];
    const scripts = checkCommands(
      'set -euo pipefail\n# a comment\nnode .github/scripts/a-b.mjs "$RUNNER_TEMP/x" --flag\ngit status\ngh api /user\n',
      "step",
      out,
    );
    expect(out).toEqual([]);
    expect(scripts).toEqual([".github/scripts/a-b.mjs"]);
  });

  it("refuses everything else", () => {
    for (const line of [
      "node --import ./x.mjs .github/scripts/a.mjs",
      "node .github/scripts/../../scripts/a.mjs",
      "node .github/scripts/a.mjs > out.txt",
      "node .github/scripts/a.mjs | tee x",
      "echo $(cat token)",
      "node .github/scripts/a.mjs ${{ github.event.issue.title }}",
      "FOO=1 node .github/scripts/a.mjs",
      "git --exec-path=/tmp push",
      "git -C ../other push",
      "source ./env.sh",
    ]) {
      const out: string[] = [];
      checkCommands(line, "step", out);
      expect(out, line).toHaveLength(1);
    }
  });
});
