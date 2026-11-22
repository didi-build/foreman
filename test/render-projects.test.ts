// Unit and integration: the Platform render with the settings repository's project list (D-377,
// D-436, D-442, ADR 0118 appendix A and slice 1, O-157). The checkouts are folders made here or the
// test fixture `test/fixtures/foreman-projects/`, which holds the marker and the rehearsal's file
// exactly as the first-hosting runbook gives them for Didi to commit; it is a fixture, not the real
// list. Platform values are the made-up ones of test/admin-workflows-fixture.ts. Nothing here
// talks to a cluster or to GitHub.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { agentNamespace } from "../src/adapters/agent-runtime/kubernetes/names.ts";
import { RUN_WATCHER, type Deployment } from "../infra/kubernetes/platform.ts";
import {
  clusterObjects,
  clusterSettingsOf,
  forServerSideApply,
  readProjectsCheckout,
  renderFiles,
  type PlatformSettingsFile,
} from "../infra/kubernetes/render.ts";
import {
  PROJECT_ENTRY_REFUSALS,
  isProjectEntrySlug,
  parseProjectEntry,
  parseProjectQuota,
} from "../src/core/project-entry.ts";
import { PROJECT_SLUG } from "../src/core/project-repository.ts";
import { RUN_WATCHER_ENV } from "../src/run-watcher/settings.ts";
import {
  SETTINGS_FILE,
  committedSettings,
  filledSettings,
} from "./admin-workflows-fixture.ts";

const FIXTURE = "test/fixtures/foreman-projects";
const MARKER = '{ "schema": 1 }\n';

/**
 * The `projects` entry infra/kubernetes/settings/production.json held before the list moved
 * (commit 69cc1d2): what the cluster runs today. The render from the fixture must equal the render
 * from this, object for object.
 */
const BEFORE_THE_MOVE = [
  {
    slug: "rehearsal",
    quota: {
      pods: 12,
      cpu: "6",
      memory: "5Gi",
      ephemeralStorage: "11Gi",
      storage: "3Gi",
      persistentVolumeClaims: 3,
    },
  },
];

const fixtureFile = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURE, "projects", name), "utf8")) as Record<
    string,
    unknown
  >;

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** A checkout with the marker and these project files, each a copy of the rehearsal's. */
function checkout(
  files: Record<string, unknown> = {},
  marker: string | null = MARKER,
): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-projects-"));
  roots.push(dir);
  if (marker !== null) writeFileSync(join(dir, "foreman-projects.json"), marker);
  writeFileSync(join(dir, "README.md"), "# foreman-projects\n");
  mkdirSync(join(dir, "projects"));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(
      join(dir, "projects", name),
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  return dir;
}

/** The rehearsal's file with another slug and, optionally, other values. */
const projectFile = (slug: string, extra: Record<string, unknown> = {}) => ({
  ...fixtureFile("rehearsal.json"),
  slug,
  ...extra,
});

/** The committed settings file's shape with made-up platform values and an API address. */
function settingsFile(): PlatformSettingsFile {
  const committed = committedSettings() as unknown as PlatformSettingsFile;
  const filled = filledSettings();
  return {
    platform: filled.platform,
    projectStandardQuota: committed.projectStandardQuota,
    ...(committed.eval ? { eval: committed.eval } : {}),
  };
}

const render = (dir: string, file: PlatformSettingsFile = settingsFile()) =>
  forServerSideApply(
    clusterObjects(clusterSettingsOf(file, readProjectsCheckout(dir))),
  );

/** The run watcher's `AGENT_NAMESPACES`, the list of namespaces it watches (D-330). */
function watcherNamespaces(list: ReturnType<typeof render>): string | undefined {
  const watcher = list.items.find(
    (o): o is Deployment =>
      o.kind === "Deployment" && o.metadata.name === RUN_WATCHER.name,
  );
  const variable = watcher?.spec.template.spec.containers[0]?.env?.find(
    (e) => e.name === RUN_WATCHER_ENV.agentNamespaces,
  );
  return variable && "value" in variable ? variable.value : undefined;
}

describe("the render from the settings repository (unit: D-377, ADR 0118 appendix A)", () => {
  it("renders exactly today's objects from the rehearsal fixture: nothing in the cluster changes", () => {
    const file = settingsFile();
    const today = forServerSideApply(
      clusterObjects({
        platform: file.platform,
        projects: BEFORE_THE_MOVE,
        ...(file.eval ? { eval: file.eval } : {}),
      }),
    );
    expect(render(FIXTURE, file)).toEqual(today);
    // The committed file now holds no project list, and its standard size is the rehearsal's.
    const committed = committedSettings();
    expect("projects" in committed).toBe(false);
    expect(committed.projectStandardQuota).toEqual(BEFORE_THE_MOVE[0]?.quota);
  });

  it("reads one project, with the quota its own file states", () => {
    const dir = checkout({ "rehearsal.json": projectFile("rehearsal") });
    const entries = readProjectsCheckout(dir);
    expect(entries.map((e) => e.slug)).toEqual(["rehearsal"]);
    const quota = render(dir).items.find(
      (o) => o.kind === "ResourceQuota" && o.metadata.namespace === "agents-rehearsal",
    );
    expect(quota).toMatchObject({
      metadata: { name: "agents" },
      spec: {
        hard: {
          pods: "12",
          "requests.cpu": "6",
          "limits.memory": "5Gi",
          "limits.ephemeral-storage": "11Gi",
          "requests.storage": "3Gi",
          persistentvolumeclaims: "3",
        },
      },
    });
  });

  it("sorts several projects by slug, so AGENT_NAMESPACES keeps a stable order", () => {
    const dir = checkout({
      "shop-2.json": projectFile("shop-2"),
      "a.json": projectFile("a"),
      "rehearsal.json": projectFile("rehearsal"),
      "a-b.json": projectFile("a-b"),
      "foreman.json": projectFile("foreman", { deployTarget: "cluster" }),
    });
    const slugs = ["a", "a-b", "foreman", "rehearsal", "shop-2"];
    expect(readProjectsCheckout(dir).map((e) => e.slug)).toEqual(slugs);
    const list = render(dir);
    expect(watcherNamespaces(list)).toBe(slugs.map((s) => `agents-${s}`).join(","));
    expect(
      list.items.filter((o) => o.kind === "Namespace").map((o) => o.metadata.name),
    ).toEqual([
      "foreman-platform",
      "foreman-runner",
      ...slugs.map((s) => `agents-${s}`),
      "foreman-eval",
    ]);
  });

  it("gives each project the quota in its file, so a bigger size Didi sets by hand reaches its namespace only", () => {
    const bigger = { ...BEFORE_THE_MOVE[0]?.quota, pods: 20, cpu: "8" };
    const dir = checkout({
      "rehearsal.json": projectFile("rehearsal"),
      "shop-2.json": projectFile("shop-2", { quota: bigger }),
    });
    const hard = (ns: string) =>
      (
        render(dir).items.find(
          (o) => o.kind === "ResourceQuota" && o.metadata.namespace === ns,
        ) as { spec: { hard: Record<string, string> } }
      ).spec.hard;
    expect(hard("agents-shop-2")).toMatchObject({ pods: "20", "requests.cpu": "8" });
    expect(hard("agents-rehearsal")).toMatchObject({ pods: "12", "requests.cpu": "6" });
  });

  it("renders no agent namespace from a checkout with no project file", () => {
    const list = render(checkout());
    expect(list.items.some((o) => o.metadata.name.startsWith("agents-"))).toBe(false);
    expect(watcherNamespaces(list)).toBe("");
  });

  it("stops at one bad file, naming it and the rule it breaks", () => {
    const good = { "rehearsal.json": projectFile("rehearsal") };
    const cases: [Record<string, unknown>, string][] = [
      [
        { ...good, "shop-2.json": projectFile("shop-2", { deployTarget: "aws" }) },
        `projects/shop-2.json: ${PROJECT_ENTRY_REFUSALS.deploy_target}`,
      ],
      [
        { ...good, "shop-2.json": projectFile("shop-3") },
        `projects/shop-2.json: ${PROJECT_ENTRY_REFUSALS.file_name}`,
      ],
      [
        { ...good, "shop-2.json": "{ not json" },
        `projects/shop-2.json: ${PROJECT_ENTRY_REFUSALS.not_json}`,
      ],
      [
        { ...good, "shop-2.json": projectFile("shop-2", { size: "large" }) },
        `projects/shop-2.json: ${PROJECT_ENTRY_REFUSALS.fields}`,
      ],
      [
        { ...good, "README.md": "# notes\n" },
        "projects/README.md: only project files, <slug>.json, may be in projects/.",
      ],
      [
        { ...good, "shop`2.json": projectFile("shop-2") },
        `a file in projects/: ${PROJECT_ENTRY_REFUSALS.file_name}`,
      ],
    ];
    for (const [files, message] of cases) {
      expect(() => readProjectsCheckout(checkout(files)), message).toThrow(message);
    }
  });

  it("refuses a folder in projects/ and a link, even one named like a project file", () => {
    const dir = checkout({ "rehearsal.json": projectFile("rehearsal") });
    mkdirSync(join(dir, "projects", "shop-2.json"));
    expect(() => readProjectsCheckout(dir)).toThrow(
      /^projects\/shop-2\.json: only project files/,
    );
    const linked = checkout();
    symlinkSync(
      resolve(FIXTURE, "projects", "rehearsal.json"),
      join(linked, "projects", "rehearsal.json"),
    );
    expect(() => readProjectsCheckout(linked)).toThrow(
      /^projects\/rehearsal\.json: only project files/,
    );
  });

  it("refuses a missing checkout, a missing or wrong marker and a missing projects folder, never reading them as an empty list", () => {
    const missing = join(tmpdir(), "foreman-projects-does-not-exist-0001");
    expect(() => readProjectsCheckout(missing)).toThrow(
      "foreman-projects.json is missing: the folder is not a checkout of didi-build/foreman-projects.",
    );
    expect(() => readProjectsCheckout(checkout({}, null))).toThrow(
      "foreman-projects.json is missing",
    );
    for (const marker of ['{"schema": 2}', "{}", "not json", '{"schema": 1, "x": 1}']) {
      expect(() => readProjectsCheckout(checkout({}, marker)), marker).toThrow(
        'foreman-projects.json: the marker must be exactly {"schema": 1}.',
      );
    }
    const noFolder = checkout();
    rmSync(join(noFolder, "projects"), { recursive: true });
    expect(() => readProjectsCheckout(noFolder)).toThrow(
      "projects/ is missing from the checkout of didi-build/foreman-projects.",
    );
  });

  it("holds the platform settings file to the standard size and to no project list of its own (D-436)", () => {
    const dir = checkout({ "rehearsal.json": projectFile("rehearsal") });
    expect(parseProjectQuota(committedSettings().projectStandardQuota)).toEqual(
      fixtureFile("rehearsal.json").quota,
    );
    const file = settingsFile();
    expect(() =>
      render(dir, { ...file, projects: BEFORE_THE_MOVE } as PlatformSettingsFile),
    ).toThrow(
      "The platform settings file still lists projects: the project list is didi-build/foreman-projects (D-377).",
    );
    for (const standard of [
      undefined,
      {},
      { ...file.projectStandardQuota, pods: "12" },
    ]) {
      expect(() =>
        render(dir, {
          ...file,
          projectStandardQuota: standard,
        } as unknown as PlatformSettingsFile),
      ).toThrow(
        "projectStandardQuota in the platform settings file is not a quota in full (D-436).",
      );
    }
  });

  it("keeps every slug the entry rule accepts inside the agent namespace's rule and the stack's slug rule", () => {
    for (const slug of ["a", "0x", "shop-2", "a-b-c", "a".repeat(47), "x1-y2-z3"]) {
      expect(isProjectEntrySlug(slug), slug).toBe(true);
      expect(agentNamespace(slug)).toBe(`agents-${slug}`);
      expect(PROJECT_SLUG.test(slug), slug).toBe(true);
    }
  });
});

describe("the starting files Didi commits (unit: repo guard, first-hosting runbook step 18)", () => {
  it("are, in the runbook, exactly the test fixture's marker and rehearsal file", () => {
    const runbook = readFileSync("docs/runbooks/first-hosting.md", "utf8");
    const start = runbook.indexOf("## 18. Move the project list to foreman-projects");
    expect(start).toBeGreaterThan(0);
    const step = runbook.slice(start, runbook.indexOf("\n## ", start + 1));
    const blocks = [...step.matchAll(/^ {3}```json\n([\s\S]*?)^ {3}```$/gm)].map((m) =>
      (m[1] ?? "").replace(/^ {3}/gm, ""),
    );
    expect(blocks).toEqual([
      readFileSync(join(FIXTURE, "foreman-projects.json"), "utf8"),
      readFileSync(join(FIXTURE, "projects", "rehearsal.json"), "utf8"),
    ]);
    expect(step).toContain("`foreman-projects.json`");
    expect(step).toContain("`projects/rehearsal.json`");
  });
});

describe("Foreman's own project file Didi commits (unit: repo guard, runbook step 20, ADR 0118 slice 9, O-166)", () => {
  const foremanFile = (): string => {
    const runbook = readFileSync("docs/runbooks/first-hosting.md", "utf8");
    const start = runbook.indexOf("## 20. Foreman as its own project");
    expect(start).toBeGreaterThan(0);
    const step = runbook.slice(start, runbook.indexOf("\n## ", start + 1));
    const blocks = [...step.matchAll(/^ {3}```json\n([\s\S]*?)^ {3}```$/gm)].map((m) =>
      (m[1] ?? "").replace(/^ {3}/gm, ""),
    );
    expect(blocks).toHaveLength(1);
    return blocks[0] ?? "";
  };

  it("is a valid project file on the cluster target with the standard size, as written", () => {
    const parsed = parseProjectEntry("foreman.json", foremanFile());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entry).toMatchObject({
      slug: "foreman",
      displayName: "Foreman",
      collectsPersonalData: true,
      deployTarget: "cluster",
      createdOn: "2026-10-28",
    });
    expect(parsed.entry.quota).toEqual(settingsFile().projectStandardQuota);
  });

  it("renders agents-foreman like any project's, and the run watcher watches it", () => {
    const dir = checkout({
      "rehearsal.json": fixtureFile("rehearsal.json"),
      "foreman.json": foremanFile(),
    });
    const list = render(dir);
    expect(watcherNamespaces(list)).toBe("agents-foreman,agents-rehearsal");
    const ofForeman = list.items.filter(
      (o) =>
        o.metadata.namespace === "agents-foreman" ||
        o.metadata.name === "agents-foreman",
    );
    expect(ofForeman.map((o) => o.kind).sort()).toEqual(
      list.items
        .filter(
          (o) =>
            o.metadata.namespace === "agents-rehearsal" ||
            o.metadata.name === "agents-rehearsal",
        )
        .map((o) => o.kind)
        .sort(),
    );
    expect(ofForeman).toHaveLength(7);
  });
});

describe("node infra/kubernetes/render.ts (integration: the Platform workflow's render step)", () => {
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["infra/kubernetes/render.ts", ...args], {
      encoding: "utf8",
    });

  it("prints the render of the settings file and the checkout", () => {
    const dir = checkout();
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify(settingsFile()));
    const result = cli([settings, FIXTURE]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      JSON.parse(JSON.stringify(renderFiles(settings, FIXTURE))),
    );
    expect(JSON.parse(result.stdout)).toEqual(
      JSON.parse(JSON.stringify(render(FIXTURE))),
    );
  });

  it("asks for both inputs, and prints only the fixed message of a refusal", () => {
    const dir = checkout({ "shop-2.json": projectFile("shop-3") });
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify(settingsFile()));
    const usage = cli([settings]);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain(
      "usage: node infra/kubernetes/render.ts <settings.json> <projects checkout>",
    );
    const bad = cli([settings, dir]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toBe(
      `projects/shop-2.json: ${PROJECT_ENTRY_REFUSALS.file_name}\n`,
    );
    // The committed file with the placeholder address renders with the fixture as the workflow does.
    const committed = join(dir, "committed.json");
    writeFileSync(
      committed,
      JSON.stringify({
        ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")),
        platform: settingsFile().platform,
      }),
    );
    expect(cli([committed, FIXTURE]).status).toBe(0);
  });
});
