// Seam: the Windmill deploy's bundle job, scripts/windmill-bundle.ts (integration: esbuild on the
// real flow entries, D-371, O-123), and the manifest it writes, which the deploy job's protected
// script reads (.github/scripts/windmill-deploy.sh, run here against the fake curl). The settings
// are made up (test/admin-workflows-fixture.ts and the digests below), so no test reads a
// production setting; the committed agent run settings are checked as a repo guard. Nothing is
// deployed and nothing leaves the machine.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { stateApiRunSettings } from "../infra/kubernetes/platform.ts";
import type { KubernetesRunSettings } from "../src/adapters/agent-runtime/kubernetes/manifests.ts";
import {
  AGENT_RUNS_FILE,
  DEPLOYED_VALUES,
  bundleForWindmill,
  summary,
  writeBundleResult,
  type BundleResult,
} from "../scripts/windmill-bundle.ts";
import { filledSettings } from "./admin-workflows-fixture.ts";

const ROOT = resolve(".");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const description = parseYaml(readFileSync("flows/windmill.yaml", "utf8")) as {
  flows: {
    name: string;
    path: string;
    entry: string;
    trigger: string;
    job_token_scopes: string[];
    schedule?: { cron: string; timezone: string };
  }[];
};
const digest = (c: string) => `@sha256:${c.repeat(64)}`;

const work: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "windmill-bundle-"));
  work.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of work.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Platform = {
  platform: {
    images: { egressProxy: string };
    receiver: Record<string, string>;
    clusterDns: unknown;
  };
};
/** The platform settings made up, with App names in the shapes GitHub gives them (step 13). */
const filledPlatform = filledSettings() as unknown as Platform;
const platform: Platform = {
  ...filledPlatform,
  platform: {
    ...filledPlatform.platform,
    receiver: {
      developerAppLogin: "test-only-developer[bot]",
      designerAppLogin: "test-only-designer[bot]",
      runnerAppSlug: "test-only-runner",
    },
  },
};
const committedAgentRuns = () =>
  JSON.parse(readFileSync(AGENT_RUNS_FILE, "utf8")) as {
    agentImages: Record<string, string>;
    runSettings: Record<string, unknown>;
  };
/** The committed agent run settings with made-up digests for the images it leaves empty. */
const filledAgentRuns = () => {
  const committed = committedAgentRuns();
  return {
    agentImages: {
      opencode: `registry.example.com/test-only/opencode${digest("a")}`,
      "claude-api": `registry.example.com/test-only/claude-api${digest("b")}`,
    },
    runSettings: {
      ...committed.runSettings,
      fetchImage: `registry.example.com/test-only/fetch${digest("c")}`,
      repoMapImage: `registry.example.com/test-only/repo-map${digest("d")}`,
    },
  };
};
const settingsFiles = (
  agentRuns: unknown = committedAgentRuns(),
  platformSettings: unknown = platform,
) => {
  const dir = folder();
  writeFileSync(join(dir, "platform.json"), JSON.stringify(platformSettings));
  writeFileSync(join(dir, "agent-runs.json"), JSON.stringify(agentRuns));
  return {
    platformSettingsFile: join(dir, "platform.json"),
    agentRunsFile: join(dir, "agent-runs.json"),
  };
};
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

let empty: BundleResult;
let filled: BundleResult;
beforeAll(async () => {
  empty = await bundleForWindmill({ commit: COMMIT, ...settingsFiles() });
  filled = await bundleForWindmill({
    commit: COMMIT,
    ...settingsFiles(filledAgentRuns()),
  });
}, 120_000);

describe("the bundle job's manifest (integration: esbuild on the real entries, D-371, O-123)", () => {
  it("lists every entry of flows/windmill.yaml as a script, in its order, but the approval flow", () => {
    const scripts = description.flows.filter((f) => f.trigger !== "approval_resume");
    expect(empty.manifest.scripts.map((s) => s.path)).toEqual(
      scripts.map((f) => f.path),
    );
    for (const [i, flow] of scripts.entries()) {
      const script = empty.manifest.scripts[i];
      expect(script?.path).toBe(`f/foreman/${flow.name}`);
      expect(script?.content).toBe(readFileSync(flow.entry, "utf8"));
      expect(script?.job_token_scopes, flow.name).toEqual(flow.job_token_scopes);
      const bundle = empty.bundles.get(flow.name) as Uint8Array;
      expect(script?.sha256).toBe(sha(bundle));
      expect(script?.size).toBe(bundle.byteLength);
    }
    expect([...empty.bundles.keys()].sort()).toEqual(scripts.map((f) => f.name).sort());
    expect(empty.notDeployed).toEqual([
      {
        path: "f/foreman/approval",
        reason:
          "a Windmill flow whose ask step is not built (M4.1); the deploy token has no flows scope (D-371)",
      },
    ]);
    expect(Object.keys(empty.manifest)).toEqual([
      "version",
      "commit",
      "scripts",
      "schedules",
      "values",
    ]);
    expect(empty.manifest.version).toBe(1);
    expect(empty.manifest.commit).toBe(COMMIT);
  });

  it("lists each schedule with its cron, time zone and script, as the yaml gives them", () => {
    expect(empty.manifest.schedules).toEqual(
      description.flows
        .filter((f) => f.schedule !== undefined)
        .map((f) => ({
          path: f.path,
          schedule: f.schedule?.cron,
          timezone: f.schedule?.timezone,
          script_path: f.path,
        })),
    );
    expect(empty.manifest.schedules.map((s) => s.path)).toEqual([
      "f/foreman/reconcile",
      "f/foreman/scan",
      "f/foreman/daily_check",
    ]);
  });

  it("writes spec_version as the commit and the App names from the platform settings, and leaves out the two JSON values while their images are empty", () => {
    expect(empty.manifest.values).toEqual([
      { name: "spec_version", value: COMMIT },
      {
        name: "github_developer_app_login",
        value: platform.platform.receiver.developerAppLogin,
      },
      {
        name: "github_designer_app_login",
        value: platform.platform.receiver.designerAppLogin,
      },
      {
        name: "github_runner_app_slug",
        value: platform.platform.receiver.runnerAppSlug,
      },
    ]);
    expect(empty.notWritten).toEqual([
      {
        name: "agent_run_settings",
        reason: `fetchImage is empty in ${AGENT_RUNS_FILE}`,
      },
      { name: "agent_images", reason: `claude-api is empty in ${AGENT_RUNS_FILE}` },
    ]);
  });

  it("writes agent_run_settings as the runner reads it, with the platform's proxy image, state API route and cluster DNS, and agent_images by kind", () => {
    expect(filled.manifest.values.map((v) => v.name)).toEqual([...DEPLOYED_VALUES]);
    expect(filled.notWritten).toEqual([]);
    const value = (name: string) =>
      JSON.parse(
        filled.manifest.values.find((v) => v.name === name)?.value ?? "null",
      ) as unknown;
    const agentRuns = filledAgentRuns();
    const settings = value("agent_run_settings") as KubernetesRunSettings;
    expect(settings).toEqual({
      proxyImage: platform.platform.images.egressProxy,
      ...agentRuns.runSettings,
      stateApi: stateApiRunSettings(),
      clusterDns: platform.platform.clusterDns,
    });
    expect(Object.keys(settings)[0]).toBe("proxyImage");
    expect(value("agent_images")).toEqual(agentRuns.agentImages);
  });

  it("holds the committed run settings at D-372's sizes and ADR 0106's starting values, with only the images left to fill", () => {
    const { agentImages, runSettings } = committedAgentRuns();
    // Every bot file's image kind, and nothing pinned yet (filled from the Images workflow).
    expect(agentImages).toEqual({ opencode: "", "claude-api": "" });
    expect(runSettings.fetchImage).toBe("");
    expect(runSettings.repoMapImage).toBe("");
    const sizes = runSettings.resources as Record<
      string,
      { requests: Record<string, string>; limits: Record<string, string> }
    >;
    const cpuAndMemory = Object.fromEntries(
      Object.entries(sizes).map(([kind, r]) => [
        kind,
        [r.requests.cpu, r.requests.memory, r.limits.cpu, r.limits.memory],
      ]),
    );
    expect(cpuAndMemory).toEqual({
      agent: ["250m", "512Mi", "1", "1Gi"],
      proxy: ["50m", "64Mi", "250m", "128Mi"],
      fetch: ["100m", "128Mi", "500m", "256Mi"],
      repoMap: ["250m", "1Gi", "1", "1536Mi"],
    });
    expect(runSettings).toMatchObject({
      terminationGracePeriodSeconds: 30,
      ttlSecondsAfterFinished: 3 * 60 * 60,
      repoMapMaxMinutes: 5,
      workspace: { size: "1Gi", storageClassName: "do-block-storage" },
    });
  });

  it("gives the same bundles and manifest for the same checkout", async () => {
    const again = await bundleForWindmill({ commit: COMMIT, ...settingsFiles() });
    expect(again.manifest).toEqual(empty.manifest);
    for (const [name, bundle] of empty.bundles)
      expect(sha(again.bundles.get(name) as Uint8Array), name).toBe(sha(bundle));
  }, 60_000);

  it("carries no TypeScript compiler in any bundle, and the bundle files embedded", () => {
    for (const [name, bundle] of empty.bundles) {
      const text = Buffer.from(bundle).toString("utf8");
      expect(text, name).not.toMatch(/versionMajorMinor|createProgram\(/);
      expect(text, name).toContain('"contracts/bots/qa.yaml"');
      expect(text, name).toContain(
        Buffer.from(
          readFileSync("src/adapters/store-postgres/supabase-ca.crt"),
        ).toString("base64"),
      );
    }
  });

  it("refuses an entry whose bundle would carry the TypeScript compiler", async () => {
    const root = folder();
    mkdirSync(join(root, "flows"));
    mkdirSync(join(root, "contracts"));
    symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "contracts", "probe.txt"), "probe\n");
    writeFileSync(
      join(root, "flows", "probe.ts"),
      'import ts from "typescript";\nexport async function main() {\n  return ts.version;\n}\n',
    );
    writeFileSync(
      join(root, "flows", "windmill.yaml"),
      [
        "workspace_folder: f/foreman",
        "bundle_files:",
        "  - contracts/",
        "flows:",
        "  - name: probe",
        "    path: f/foreman/probe",
        "    entry: flows/probe.ts",
        "    trigger: called",
        '    job_token_scopes: ["variables:read:f/foreman/*"]',
        "resources:",
        "  values: []",
        "",
      ].join("\n"),
    );
    await expect(
      bundleForWindmill({ commit: COMMIT, root, ...settingsFiles() }),
    ).rejects.toThrow("flows/probe.ts's bundle includes the TypeScript compiler");
  }, 60_000);

  it("refuses settings it cannot use, naming the setting", async () => {
    const agentRuns = filledAgentRuns();
    const cases: [unknown, unknown, string][] = [
      [
        {
          ...agentRuns,
          runSettings: {
            ...agentRuns.runSettings,
            fetchImage: "registry.example.com/fetch:latest",
          },
        },
        platform,
        `runSettings in ${AGENT_RUNS_FILE}: fetchImage is not an image reference pinned by digest`,
      ],
      [
        { ...agentRuns, runSettings: { ...agentRuns.runSettings, extra: 1 } },
        platform,
        `runSettings in ${AGENT_RUNS_FILE} must hold exactly`,
      ],
      [
        { ...agentRuns, agentImages: { opencode: agentRuns.agentImages.opencode } },
        platform,
        `agentImages in ${AGENT_RUNS_FILE} must hold exactly claude-api, opencode`,
      ],
      [
        { ...agentRuns, runSettings: { ...agentRuns.runSettings, runAsUser: 0 } },
        platform,
        `runSettings in ${AGENT_RUNS_FILE}: runAsUser is not a whole number from 1`,
      ],
      [
        agentRuns,
        {
          platform: {
            ...platform.platform,
            images: {
              ...platform.platform.images,
              egressProxy: "registry.example.com/proxy:latest",
            },
          },
        },
        "platform.images.egressProxy in infra/kubernetes/settings/production.json is not an image reference pinned by digest",
      ],
      [
        agentRuns,
        {
          platform: {
            ...platform.platform,
            receiver: { ...platform.platform.receiver, developerAppLogin: "" },
          },
        },
        "platform.receiver.developerAppLogin in infra/kubernetes/settings/production.json is not an App's login",
      ],
    ];
    for (const [runs, platformSettings, message] of cases) {
      await expect(
        bundleForWindmill({ commit: COMMIT, ...settingsFiles(runs, platformSettings) }),
        message,
      ).rejects.toThrow(message);
    }
    await expect(
      bundleForWindmill({ commit: "main", ...settingsFiles() }),
    ).rejects.toThrow("--commit is not a full commit id");
  }, 60_000);
});

describe("the bundle job's summary and files (integration, D-371, O-123)", () => {
  it("lists each script with its bundle's sha256 and size, each schedule, and each value by name and hash only", () => {
    const text = summary(filled);
    for (const script of filled.manifest.scripts)
      expect(text).toContain(
        `| \`${script.path}\` | \`${script.sha256}\` | ${script.size} |`,
      );
    for (const schedule of filled.manifest.schedules)
      expect(text).toContain(`| \`${schedule.path}\` | \`${schedule.schedule}\` |`);
    for (const value of filled.manifest.values) {
      expect(text).toContain(
        `| \`f/foreman/${value.name}\` | \`${sha(value.value)}\` |`,
      );
      if (value.name !== "spec_version") expect(text).not.toContain(value.value);
    }
    expect(text).toContain("Not deployed: `f/foreman/approval`");
    expect(summary(empty)).toContain(
      `Not written: \`f/foreman/agent_images\`, since claude-api is empty in ${AGENT_RUNS_FILE}.`,
    );
  });

  it("writes the bundles and the manifest into an empty folder only", () => {
    const out = join(folder(), "out");
    writeBundleResult(empty, out);
    expect(readdirSync(out).sort()).toEqual(["bundles", "manifest.json"]);
    expect(readdirSync(join(out, "bundles")).sort()).toEqual(
      [...empty.bundles.keys()].map((n) => `${n}.js`).sort(),
    );
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))).toEqual(
      empty.manifest,
    );
    expect(() => writeBundleResult(empty, out)).toThrow(`${out} is not empty`);
  });

  it("stops the command with the reason on stderr, before reading any setting", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/windmill-bundle.ts",
        "--commit",
        "main",
        "--out",
        join(folder(), "out"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("--commit is not a full commit id\n");
    expect(result.stdout).toBe("");
  });

  it.skipIf(process.platform === "win32")(
    "is a manifest the deploy job's protected script accepts and uploads whole (bash with the fake curl)",
    () => {
      const box = folder();
      const out = join(box, "artifact");
      writeBundleResult(filled, out);
      mkdirSync(join(box, "bin"));
      writeFileSync(
        join(box, "bin", "curl"),
        `#!/usr/bin/env bash\nexec node ${JSON.stringify(resolve("test/fixtures/admin-workflows/fake-curl.mjs"))} "$@"\n`,
      );
      chmodSync(join(box, "bin", "curl"), 0o755);
      writeFileSync(join(box, "curl.log"), "");
      writeFileSync(join(box, "settings.json"), JSON.stringify(platform));
      mkdirSync(join(box, "runner-temp"));
      const result = spawnSync("bash", [".github/scripts/windmill-deploy.sh", out], {
        encoding: "utf8",
        env: {
          PATH: `${join(box, "bin")}:${process.env.PATH ?? ""}`,
          FAKE_CURL_LOG: join(box, "curl.log"),
          RUNNER_TEMP: join(box, "runner-temp"),
          SETTINGS_FILE: join(box, "settings.json"),
          WINDMILL_DEPLOY_TOKEN: "test-only-windmill-deploy-token-0002",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const scripts = JSON.parse(
        readFileSync(join(box, "curl.log.scripts"), "utf8"),
      ) as Record<
        string,
        { codebase: string; bundle: string; job_token_scopes: string[] }[]
      >;
      for (const script of filled.manifest.scripts) {
        expect(scripts[script.path]?.[0]).toMatchObject({
          codebase: script.sha256,
          bundle: script.sha256,
          job_token_scopes: script.job_token_scopes,
        });
      }
      const variables = JSON.parse(
        readFileSync(join(box, "curl.log.variables"), "utf8"),
      ) as Record<string, { value: string; is_secret: boolean }>;
      expect(variables).toEqual(
        Object.fromEntries(
          filled.manifest.values.map((v) => [
            `f/foreman/${v.name}`,
            expect.objectContaining({ value: v.value, is_secret: false }),
          ]),
        ),
      );
      expect(
        Object.keys(
          JSON.parse(readFileSync(join(box, "curl.log.schedules"), "utf8")) as object,
        ),
      ).toEqual(filled.manifest.schedules.map((s) => s.path));
    },
    60_000,
  );
});
