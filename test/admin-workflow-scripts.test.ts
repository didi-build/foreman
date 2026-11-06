// Integration: the admin workflows' shell scripts (.github/scripts/, D-336, D-339, D-340, O-105)
// run with bash against fake kubectl, tofu, doctl and docker on PATH, so no cluster, state,
// registry or credential is touched. Every value below is made up for the test.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RUN_TIME_KUBERNETES_API, renderedObjects } from "./admin-workflows-fixture.ts";

const SCRIPTS = resolve(".github/scripts");
const FIXTURES = resolve("test/fixtures/admin-workflows");

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop() as string, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  bin: string;
  state: string;
  log: string;
  env: Record<string, string>;
  calls: () => { args: string[]; stdin?: string }[];
  readState: () => Record<string, unknown>;
}

function sandbox(state: Record<string, unknown> = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "admin-workflow-scripts-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool(
    "kubectl",
    `exec node ${JSON.stringify(join(FIXTURES, "fake-kubectl.mjs"))} "$@"`,
  );
  tool("docker", `exec node ${JSON.stringify(join(FIXTURES, "fake-docker.mjs"))} "$@"`);
  tool(
    "tofu",
    [
      'printf "%s\\n" "$*" >>"$FAKE_TOFU_LOG"',
      'case "$*" in',
      '  *"output -raw receiver_tunnel_token"*)',
      '    if [ -n "${FAKE_TUNNEL_TOKEN:-}" ]; then printf "%s" "$FAKE_TUNNEL_TOKEN"; else echo "Error: Output \\"receiver_tunnel_token\\" not found" >&2; exit 1; fi ;;',
      '  *" init "*) echo "Initializing the backend... bucket ${STATE_BUCKET:-} at https://${CLOUDFLARE_ACCOUNT_ID:-}.r2.cloudflarestorage.com" ;;',
      "esac",
    ].join("\n"),
  );
  tool(
    "doctl",
    [
      'printf "%s\\n" "$*" >>"$FAKE_DOCTL_LOG"',
      'printf "apiVersion: v1\\nkind: Config\\nusers:\\n- name: admin\\n  user:\\n    token: %s\\n" "$FAKE_KUBE_TOKEN"',
    ].join("\n"),
  );
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify(state));
  const log = join(root, "calls.jsonl");
  writeFileSync(log, "");
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp);
  for (const file of [
    "github-output",
    "github-env",
    "github-path",
    "tofu.log",
    "doctl.log",
  ])
    writeFileSync(join(root, file), "");
  return {
    root,
    bin,
    state: statePath,
    log,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: root,
      FAKE_STATE: statePath,
      FAKE_LOG: log,
      FAKE_TOFU_LOG: join(root, "tofu.log"),
      FAKE_DOCTL_LOG: join(root, "doctl.log"),
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: join(root, "github-output"),
      GITHUB_ENV: join(root, "github-env"),
      GITHUB_PATH: join(root, "github-path"),
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    },
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; stdin?: string }),
    readState: () =>
      JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>,
  };
}

function run(
  box: Sandbox,
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
  input = "",
) {
  const result = spawnSync("bash", [join(SCRIPTS, script), ...args], {
    cwd: resolve("."),
    encoding: "utf8",
    input,
    env: { ...box.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const manifestsFile = (box: Sandbox): string => {
  const path = join(box.root, "manifests.json");
  writeFileSync(path, JSON.stringify(renderedObjects()));
  return path;
};

describe.skipIf(process.platform === "win32")(
  "admin workflow scripts (integration: bash with fake tools, D-339, D-340, O-105)",
  { timeout: 60_000 },
  () => {
    describe("redact.sh", () => {
      it("replaces the named values and every id, and keeps image digests", () => {
        const box = sandbox();
        const digest = "a".repeat(64);
        const text = [
          'account_id = "0123456789abcdef0123456789abcdef"',
          'hostname = "hooks.example.com"',
          'id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"',
          `image = "ghcr.io/didi-build/foreman-state-api@sha256:${digest}"`,
          "no newline at the end",
        ].join("\n");
        const result = run(
          box,
          "redact.sh",
          [],
          {
            REDACT_NAMES: "RECEIVER_HOSTNAME,STATE_BUCKET",
            RECEIVER_HOSTNAME: "hooks.example.com",
          },
          text,
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(
          [
            'account_id = "<id>"',
            'hostname = "<RECEIVER_HOSTNAME>"',
            'id = "<id>"',
            `image = "ghcr.io/didi-build/foreman-state-api@sha256:${digest}"`,
            "no newline at the end",
          ].join("\n"),
        );
      });

      it("refuses a name that is not a variable name", () => {
        const result = run(sandbox(), "redact.sh", [], { REDACT_NAMES: "A;B" }, "x");
        expect(result.status).toBe(2);
      });
    });

    describe("tofu-init.sh", () => {
      const env = {
        STACK: "infra/stacks/factory",
        AWS_ACCESS_KEY_ID: "test-access-key-id",
        AWS_SECRET_ACCESS_KEY: "test-only-secret-access-key-0001",
        TF_VAR_state_encryption_passphrase: "test-only-passphrase-0001",
        CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        STATE_BUCKET: "foreman-test-state",
        REDACT_NAMES: "CLOUDFLARE_ACCOUNT_ID,STATE_BUCKET",
      };

      it("inits with -input=false, the locked providers and the R2 backend, printing no id", () => {
        const box = sandbox();
        const result = run(box, "tofu-init.sh", [], env);
        expect(result.status).toBe(0);
        const call = readFileSync(box.env.FAKE_TOFU_LOG as string, "utf8");
        expect(call).toContain(
          "-chdir=infra/stacks/factory init -input=false -lockfile=readonly",
        );
        expect(call).toContain("-backend-config=bucket=foreman-test-state");
        expect(call).toContain(
          '-backend-config=endpoints={s3="https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"}',
        );
        expect(result.stdout).toContain("::add-mask::0123456789abcdef0123456789abcdef");
        const log = result.stdout
          .split("\n")
          .filter((l) => !l.startsWith("::add-mask::"))
          .join("\n");
        expect(log).toContain(
          "bucket <STATE_BUCKET> at https://<CLOUDFLARE_ACCOUNT_ID>",
        );
        expect(log).not.toContain("0123456789abcdef0123456789abcdef");
        expect(log).not.toContain("foreman-test-state");
      });

      it("names a setting that does not match, never its value, and runs nothing", () => {
        const box = sandbox();
        const result = run(box, "tofu-init.sh", [], {
          ...env,
          CLOUDFLARE_ACCOUNT_ID: 'x"}; evil',
          RECEIVER_HOSTNAME: "not a host",
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "CLOUDFLARE_ACCOUNT_ID (does not look like one)",
        );
        expect(result.stderr).toContain("RECEIVER_HOSTNAME (does not look like one)");
        expect(`${result.stdout}${result.stderr}`).not.toContain("evil");
        expect(readFileSync(box.env.FAKE_TOFU_LOG as string, "utf8")).toBe("");
      });

      it("stops when a secret is not set in the environment", () => {
        const result = run(sandbox(), "tofu-init.sh", [], {
          ...env,
          AWS_SECRET_ACCESS_KEY: "",
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "AWS_SECRET_ACCESS_KEY: is not set in this environment",
        );
      });
    });

    describe("cluster-credential.sh", () => {
      it("fetches a credential that expires with the job, into a private file, and masks its token", () => {
        const box = sandbox({ kubeconfigToken: "test-only-kube-token-0001" });
        const result = run(box, "cluster-credential.sh", [], {
          DIGITALOCEAN_ACCESS_TOKEN: "test-only-do-token-0001",
          FAKE_KUBE_TOKEN: "test-only-kube-token-0001",
          CLUSTER_NAME: "foreman",
          CREDENTIAL_SECONDS: "600",
        });
        expect(result.status).toBe(0);
        expect(readFileSync(box.env.FAKE_DOCTL_LOG as string, "utf8").trim()).toBe(
          "kubernetes cluster kubeconfig show foreman --expiry-seconds 600",
        );
        const kubeconfig = join(box.env.RUNNER_TEMP as string, "kubeconfig");
        expect(statSync(kubeconfig).mode & 0o777).toBe(0o600);
        expect(readFileSync(box.env.GITHUB_ENV as string, "utf8")).toBe(
          `KUBECONFIG=${kubeconfig}\n`,
        );
        expect(result.stdout).toContain("::add-mask::test-only-kube-token-0001");
        expect(result.stderr).not.toContain("test-only");
      });

      it("stops when the DigitalOcean token is not set, or the expiry is not a number", () => {
        const box = sandbox();
        const noToken = run(box, "cluster-credential.sh", [], {
          CLUSTER_NAME: "foreman",
          CREDENTIAL_SECONDS: "600",
        });
        expect(noToken.status).not.toBe(0);
        expect(noToken.stderr).toContain("DIGITALOCEAN_ACCESS_TOKEN: is not set");
        const badExpiry = run(box, "cluster-credential.sh", [], {
          DIGITALOCEAN_ACCESS_TOKEN: "test-only-do-token-0001",
          CLUSTER_NAME: "foreman",
          CREDENTIAL_SECONDS: "0",
        });
        expect(badExpiry.status).toBe(1);
        expect(readFileSync(box.env.FAKE_DOCTL_LOG as string, "utf8")).toBe("");
      });
    });

    describe("cluster-secrets.sh", () => {
      const VALUES = {
        STATE_API_DATABASE_URL:
          "postgresql://test-only-api:pw0001@db.example.com:5432/postgres",
        RECEIVER_DATABASE_URL:
          "postgresql://test-only-ingest:pw0002@db.example.com:5432/postgres",
        RECEIVER_WEBHOOK_SECRET: "test-only-webhook-secret-0001",
        PLANNING_TOKEN: "test-only-planning-token-0001-abcdefgh",
        STATE_API_WINDMILL_TOKEN: "test-only-windmill-plan-approval-0001",
        RECEIVER_WINDMILL_TOKEN: "test-only-windmill-receiver-0001",
        RUN_WATCHER_WINDMILL_TOKEN: "test-only-windmill-watcher-0001",
      };
      const TUNNEL = "test-only-tunnel-token-0001";
      const planningHash = createHash("sha256")
        .update(VALUES.PLANNING_TOKEN)
        .digest("hex");

      const secretsRun = (
        box: Sandbox,
        values: Record<string, string> = VALUES,
        tunnel = TUNNEL,
      ) => {
        const report = join(box.root, "report.md");
        const result = run(box, "cluster-secrets.sh", [], {
          STACK: "infra/stacks/factory",
          REPORT: report,
          FAKE_TUNNEL_TOKEN: tunnel,
          ...values,
        });
        return {
          ...result,
          report: existsSync(report) ? readFileSync(report, "utf8") : "",
        };
      };

      const everyValue = [...Object.values(VALUES), TUNNEL, planningHash];
      const expectNoValueShown = (
        box: Sandbox,
        result: { stdout: string; stderr: string; report: string },
      ) => {
        const log = result.stdout
          .split("\n")
          .filter((l) => !l.startsWith("::add-mask::"))
          .join("\n");
        for (const value of everyValue) {
          expect(log).not.toContain(value);
          expect(result.stderr).not.toContain(value);
          expect(result.report).not.toContain(value);
          for (const call of box.calls())
            expect(call.args.join(" ")).not.toContain(value);
        }
      };

      it("puts every value in through stdin only, and shows none of them", () => {
        const box = sandbox();
        const result = secretsRun(box);
        expect(result.status).toBe(0);
        expectNoValueShown(box, result);
        const stdins = box
          .calls()
          .filter((c) => c.args[0] === "create" && c.args[1] === "secret")
          .map((c) => [c.args[3], c.stdin]);
        expect(Object.fromEntries(stdins)).toEqual({
          "cloudflared-tunnel-token": TUNNEL,
          "state-api-database": VALUES.STATE_API_DATABASE_URL,
          "github-receiver-database": VALUES.RECEIVER_DATABASE_URL,
          "github-receiver-webhook-secret": VALUES.RECEIVER_WEBHOOK_SECRET,
          "state-api-planning-token": planningHash,
          "state-api-windmill-plan-approval-token": VALUES.STATE_API_WINDMILL_TOKEN,
          "github-receiver-windmill-token": VALUES.RECEIVER_WINDMILL_TOKEN,
          "run-watcher-windmill-token": VALUES.RUN_WATCHER_WINDMILL_TOKEN,
        });
        // The masks go to the log, never to the report.
        expect(result.stdout).toContain(`::add-mask::${TUNNEL}`);
        expect(result.stdout).toContain(`::add-mask::${planningHash}`);
        expect(result.report).not.toContain("::add-mask::");
      });

      it("applies server-side in the platform namespace and restarts each deployment that reads a changed Secret", () => {
        const box = sandbox();
        const result = secretsRun(box);
        const applies = box.calls().filter((c) => c.args[0] === "apply");
        expect(applies).toHaveLength(8);
        for (const call of applies) {
          expect(call.args).toContain("--server-side");
          expect(JSON.parse(call.stdin ?? "{}").metadata.namespace).toBe(
            "foreman-platform",
          );
        }
        const restarts = box
          .calls()
          .filter((c) => c.args[0] === "rollout" && c.args[1] === "restart")
          .map((c) => c.args[2]);
        expect(restarts).toEqual([
          "deployment/cloudflared",
          "deployment/github-receiver",
          "deployment/run-watcher",
          "deployment/state-api",
        ]);
        expect(result.report).toContain(
          "Restarted: `cloudflared`, `github-receiver`, `run-watcher`, `state-api`",
        );
      });

      it("hashes the planning token exactly as step 15 does: no newline in, hex only out", () => {
        const box = sandbox();
        secretsRun(box);
        const secrets = box.readState().secrets as Record<string, { data: string }>;
        const data = JSON.parse(secrets["state-api-planning-token"]?.data ?? "{}") as {
          sha256: string;
        };
        expect(Buffer.from(data.sha256, "base64").toString("utf8")).toBe(planningHash);
      });

      it("changes and restarts nothing when the values are already there", () => {
        const box = sandbox();
        secretsRun(box);
        const before = box.calls().length;
        const again = secretsRun(box);
        expect(again.status).toBe(0);
        expect(again.report).toContain("Created or updated: none");
        expect(again.report).toContain("Restarted: none");
        expect(
          box
            .calls()
            .slice(before)
            .filter((c) => c.args[0] === "rollout"),
        ).toEqual([]);
      });

      it("skips an empty environment secret by name, leaves its Secret as it is, and does not fail", () => {
        const box = sandbox();
        const result = secretsRun(box, {
          ...VALUES,
          PLANNING_TOKEN: "",
          RECEIVER_WINDMILL_TOKEN: "",
        });
        expect(result.status).toBe(0);
        expect(result.report).toContain(
          "Skipped, the environment secret is not set (the Secret is left as it is): `state-api-planning-token (PLANNING_TOKEN is not set)`, `github-receiver-windmill-token (RECEIVER_WINDMILL_TOKEN is not set)`",
        );
        const created = box
          .calls()
          .filter((c) => c.args[0] === "create")
          .map((c) => c.args[3]);
        expect(created).not.toContain("state-api-planning-token");
        expect(created).not.toContain("github-receiver-windmill-token");
        expectNoValueShown(box, result);
      });

      it("refuses by name a value with a space or newline at either end, or a planning token off the API's rule", () => {
        const box = sandbox();
        const result = secretsRun(box, {
          ...VALUES,
          RECEIVER_WEBHOOK_SECRET: `${VALUES.RECEIVER_WEBHOOK_SECRET}\n`,
          PLANNING_TOKEN: "too-short",
        });
        expect(result.status).toBe(1);
        expect(result.report).toContain(
          "`github-receiver-webhook-secret (RECEIVER_WEBHOOK_SECRET starts or ends with a space or a newline: enter it again)`",
        );
        expect(result.report).toContain(
          "`state-api-planning-token (PLANNING_TOKEN must be 32 to 256",
        );
        expect(result.report).not.toContain("too-short");
        const created = box
          .calls()
          .filter((c) => c.args[0] === "create")
          .map((c) => c.args[3]);
        expect(created).not.toContain("github-receiver-webhook-secret");
        expect(created).not.toContain("state-api-planning-token");
        expectNoValueShown(box, result);
      });

      it("refuses the tunnel token's Secret when the state holds no tunnel yet", () => {
        const box = sandbox();
        const result = secretsRun(box, VALUES, "");
        expect(result.status).toBe(1);
        expect(result.report).toContain(
          "`cloudflared-tunnel-token (the infrastructure state has no tunnel token",
        );
        expect(result.report).toContain("`state-api-database`");
      });

      it("fails, naming the deployment, when a restarted deployment is not ready", () => {
        const box = sandbox({ failRollouts: ["github-receiver"] });
        const result = secretsRun(box);
        expect(result.status).toBe(1);
        expect(result.report).toContain(
          "Not ready within 3 minutes after the restart: `github-receiver`",
        );
      });
    });

    describe("platform-plan.sh with platform-diff.sh", () => {
      const objects = renderedObjects();
      const namespaces = objects.items
        .filter((o) => o.kind === "Namespace")
        .map((o) => o.metadata.name);
      const fileName = (o: {
        apiVersion: string;
        kind: string;
        metadata: { name: string; namespace?: string };
      }) => {
        const [group, version] = o.apiVersion.includes("/")
          ? o.apiVersion.split("/")
          : ["", o.apiVersion];
        return `${group ? `${group}.` : ""}${version}.${o.kind}.${o.metadata.namespace ?? ""}.${o.metadata.name}`;
      };
      const allLive = () =>
        Object.fromEntries(objects.items.map((o) => [fileName(o), o]));
      const planRun = (box: Sandbox) => {
        const result = run(box, "platform-plan.sh", [manifestsFile(box)], {
          FIELD_MANAGER: "foreman-platform-workflow",
          SETTINGS_FILE: "infra/kubernetes/settings/production.json",
        });
        return {
          ...result,
          output: readFileSync(box.env.GITHUB_OUTPUT as string, "utf8"),
        };
      };

      it("lists every object as created on a cluster with none of the namespaces", () => {
        const box = sandbox({ namespaces: [] });
        const result = planRun(box);
        expect(result.status).toBe(0);
        expect(result.output).toBe("changed=true\n");
        expect(result.stdout).toContain(
          `**${objects.items.length} object(s) to create or change.**`,
        );
        expect(result.stdout).toContain(
          "| create | Namespace | (cluster) | foreman-platform |",
        );
        expect(result.stdout).toContain(
          "| create | Deployment | foreman-platform | state-api |",
        );
        expect(result.stdout).toContain(
          "| create | Role | agents-rehearsal | run-watcher |",
        );
        expect(box.calls().some((c) => c.args[0] === "diff")).toBe(false);
      });

      it("reports no change when the cluster already holds the same objects", () => {
        const box = sandbox({ namespaces, live: allLive() });
        const result = planRun(box);
        expect(result.status).toBe(0);
        expect(result.output).toBe("changed=false\n");
        expect(result.stdout).toContain("No changes.");
        const diff = box.calls().find((c) => c.args[0] === "diff");
        expect(diff?.args).toEqual(
          expect.arrayContaining([
            "--server-side",
            "--field-manager=foreman-platform-workflow",
          ]),
        );
      });

      it("names a changed object by kind, namespace and name, and prints none of its content", () => {
        const live = allLive();
        const key = Object.keys(live).find((k) =>
          k.endsWith(".Deployment.foreman-platform.state-api"),
        );
        live[key as string] = { marker: "live-only-field-value-0001" } as never;
        const box = sandbox({ namespaces, live });
        const result = planRun(box);
        expect(result.status).toBe(0);
        expect(result.output).toBe("changed=true\n");
        expect(result.stdout).toContain(
          "| update | Deployment | foreman-platform | state-api |",
        );
        expect(result.stdout).toContain("**1 object(s) to create or change.**");
        expect(`${result.stdout}${result.stderr}`).not.toContain(
          "live-only-field-value-0001",
        );
      });

      it("fails when kubectl diff fails", () => {
        const box = sandbox({ namespaces, live: allLive(), diffExit: 2 });
        const result = planRun(box);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("::error::kubectl diff failed.");
      });
    });

    describe("platform-checks.sh", () => {
      it("passes the runbook's RBAC list on the rendered Roles", () => {
        const box = sandbox({ cluster: renderedObjects().items });
        const result = run(box, "platform-checks.sh", [manifestsFile(box), "rbac"]);
        expect(result.stdout).not.toContain("FAILED");
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          "| `run-watcher` `can-i watch jobs.batch -n agents-rehearsal` | yes | yes | ok |",
        );
        expect(result.stdout).toContain(
          "| `runner` `can-i get secrets -n agents-rehearsal` | no | no | ok |",
        );
      });

      it("fails on any right wider than D-330 gives the run watcher", () => {
        const cluster = renderedObjects().items.map((o) =>
          o.kind === "Role" && o.metadata.name === "run-watcher"
            ? {
                ...o,
                rules: [
                  ...o.rules,
                  { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
                ],
              }
            : o,
        );
        const box = sandbox({ cluster });
        const result = run(box, "platform-checks.sh", [manifestsFile(box), "rbac"]);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
          "| `run-watcher` `can-i get secrets -n agents-rehearsal` | no | yes | **FAILED** |",
        );
        expect(result.stdout).toContain("Stop and ask Didi");
      });

      const nodes = [
        {
          metadata: { name: "node-platform", labels: { "foreman/pool": "platform" } },
          spec: {},
        },
        {
          metadata: { name: "node-agents", labels: { "foreman/pool": "agents" } },
          spec: {
            taints: [{ key: "foreman/pool", value: "agents", effect: "NoSchedule" }],
          },
        },
      ];

      it("probes default deny with a restricted pod on each pool, and passes when it reaches nothing", () => {
        const box = sandbox({
          nodes,
          pods: {
            "foreman-platform/default-deny-probe": {
              phase: "Succeeded",
              nodeName: "node-platform",
            },
            "agents-rehearsal/default-deny-probe": {
              phase: "Succeeded",
              nodeName: "node-agents",
            },
          },
        });
        const result = run(box, "platform-checks.sh", [manifestsFile(box), "network"], {
          KUBERNETES_API: JSON.stringify(RUN_TIME_KUBERNETES_API),
        });
        expect(result.stdout).not.toContain("FAILED");
        expect(result.status).toBe(0);
        const created = box.readState().created as {
          metadata: { namespace: string };
          spec: Record<string, unknown> & {
            containers: {
              image: string;
              env: { value: string }[];
              securityContext: Record<string, unknown>;
            }[];
            tolerations: unknown[];
            nodeSelector: Record<string, string>;
          };
        }[];
        expect(created.map((p) => p.metadata.namespace)).toEqual([
          "foreman-platform",
          "agents-rehearsal",
        ]);
        const proxyImage = renderedObjects().items.find(
          (o) => o.kind === "Deployment" && o.metadata.name === "windmill-proxy",
        );
        for (const pod of created) {
          expect(pod.spec.automountServiceAccountToken).toBe(false);
          expect(pod.spec.containers[0]?.securityContext).toMatchObject({
            runAsNonRoot: true,
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          });
          expect(pod.spec.containers[0]?.image).toBe(
            proxyImage?.kind === "Deployment"
              ? proxyImage.spec.template.spec.containers[0]?.image
              : "",
          );
          expect(JSON.parse(pod.spec.containers[0]?.env[0]?.value ?? "[]")).toEqual([
            { host: "1.1.1.1", port: 443 },
            { host: "192.0.2.10", port: 443 },
          ]);
        }
        expect(created[0]?.spec.nodeSelector).toEqual({ "foreman/pool": "platform" });
        expect(created[0]?.spec.tolerations).toEqual([]);
        expect(created[1]?.spec.nodeSelector).toEqual({ "foreman/pool": "agents" });
        expect(created[1]?.spec.tolerations).toHaveLength(1);
      });

      it("fails when a probe reaches something, or lands on the wrong pool", () => {
        const box = sandbox({
          nodes,
          pods: {
            "foreman-platform/default-deny-probe": {
              phase: "Failed",
              nodeName: "node-platform",
              log: '{"dns":true}',
            },
            "agents-rehearsal/default-deny-probe": {
              phase: "Succeeded",
              nodeName: "node-platform",
            },
          },
        });
        const result = run(box, "platform-checks.sh", [manifestsFile(box), "network"]);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
          "| default deny in `foreman-platform`: the probe reaches nothing | blocked | reached something | **FAILED** |",
        );
        expect(result.stdout).toContain(
          "| probe in `agents-rehearsal` lands on the agents pool | agents | platform | **FAILED** |",
        );
      });

      it("checks the agents pool's taint and that pods run on their own pool", () => {
        const untainted = [nodes[0], { ...nodes[1], spec: {} }];
        const box = sandbox({
          nodes: untainted,
          pods: {
            "foreman-platform/state-api-1": { nodeName: "node-platform" },
            "foreman-platform/github-receiver-1": { nodeName: "node-agents" },
          },
        });
        const result = run(box, "platform-checks.sh", [manifestsFile(box), "pools"]);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
          "| agent node `node-agents` carries the NoSchedule taint | yes | no | **FAILED** |",
        );
        expect(result.stdout).toContain(
          "| pod `foreman-platform/state-api-1` runs on the platform pool | platform | platform | ok |",
        );
        expect(result.stdout).toContain(
          "| pod `foreman-platform/github-receiver-1` runs on the platform pool | platform | agents | **FAILED** |",
        );
      });
    });

    describe("infra-plan-summary.sh", () => {
      const summarize = (changes: unknown[]) => {
        const box = sandbox();
        const changesFile = join(box.root, "changes.json");
        const planFile = join(box.root, "plan.txt");
        writeFileSync(changesFile, JSON.stringify(changes));
        writeFileSync(planFile, '  + resource "cloudflare_dns_record" "receiver" {}\n');
        return run(box, "infra-plan-summary.sh", [changesFile, planFile]);
      };

      it("names the gates a plan touches and the resources that change, then the plan", () => {
        const result = summarize([
          {
            address: "module.edge.cloudflare_dns_record.receiver[0]",
            type: "cloudflare_dns_record",
            actions: ["create"],
          },
          {
            address: "module.cluster.digitalocean_firewall.workers",
            type: "digitalocean_firewall",
            actions: ["no-op"],
          },
          {
            address: "module.cluster.digitalocean_kubernetes_node_pool.agents",
            type: "digitalocean_kubernetes_node_pool",
            actions: ["delete", "create"],
          },
        ]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("| create | 1 |");
        expect(result.stdout).toContain("| replace | 1 |");
        expect(result.stdout).toContain("**DNS change** (DNS gate, D-195)");
        expect(result.stdout).toContain("**Deletes or replaces**");
        expect(result.stdout).toContain("**Spending**");
        expect(result.stdout).not.toContain("**Network rules**");
        expect(result.stdout).toContain(
          "| create | `module.edge.cloudflare_dns_record.receiver[0]` |",
        );
        expect(result.stdout).not.toContain("digitalocean_firewall.workers");
        expect(result.stdout).toContain('resource "cloudflare_dns_record" "receiver"');
      });

      it("says so when nothing changes", () => {
        const result = summarize([
          {
            address: "module.cluster.digitalocean_firewall.workers",
            type: "digitalocean_firewall",
            actions: ["no-op"],
          },
        ]);
        expect(result.stdout).toContain("No changes. Nothing to apply.");
        expect(result.stdout).toContain("None: no DNS record");
      });
    });

    describe("build-images.sh", () => {
      it("builds and pushes the seven images by commit tag, with no build argument or secret, and writes their digests", () => {
        const box = sandbox();
        const commit = "0123456789abcdef0123456789abcdef01234567";
        const out = join(box.root, "images.json");
        const result = run(box, "build-images.sh", [out], {
          REGISTRY: "ghcr.io/didi-build",
          COMMIT: commit,
          SOURCE_URL: "https://github.com/didi-build/foreman",
        });
        expect(result.status).toBe(0);
        const calls = box.calls();
        const builds = calls.filter((c) => c.args[0] === "build");
        expect(builds.map((c) => c.args[c.args.indexOf("--file") + 1])).toEqual([
          "src/agent-images/opencode/Dockerfile",
          "src/agent-images/claude-api/Dockerfile",
          "src/agent-images/repo-map/Dockerfile",
          "src/egress-proxy/Dockerfile",
          "src/api/Dockerfile",
          "src/github-receiver/Dockerfile",
          "src/run-watcher/Dockerfile",
        ]);
        for (const call of calls) {
          for (const flag of ["--build-arg", "--secret", "--ssh"]) {
            expect(call.args.some((a) => a.startsWith(flag))).toBe(false);
          }
        }
        expect(calls.filter((c) => c.args[0] === "push").map((c) => c.args[1])).toEqual(
          [
            "foreman-agent-opencode",
            "foreman-agent-claude-api",
            "foreman-repo-map",
            "foreman-egress-proxy",
            "foreman-state-api",
            "foreman-github-receiver",
            "foreman-run-watcher",
          ].map((name) => `ghcr.io/didi-build/${name}:${commit}`),
        );
        const digestOf = (name: string) =>
          `ghcr.io/didi-build/${name}@sha256:${createHash("sha256")
            .update(`ghcr.io/didi-build/${name}:${commit}`)
            .digest("hex")}`;
        const images = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
        expect(images.settingsFile).toEqual({
          platform: {
            images: {
              stateApi: digestOf("foreman-state-api"),
              receiver: digestOf("foreman-github-receiver"),
              egressProxy: digestOf("foreman-egress-proxy"),
              runWatcher: digestOf("foreman-run-watcher"),
            },
          },
        });
        expect(images.windmill).toEqual({
          agent_images: {
            opencode: digestOf("foreman-agent-opencode"),
            "claude-api": digestOf("foreman-agent-claude-api"),
          },
          agent_run_settings: {
            proxyImage: digestOf("foreman-egress-proxy"),
            repoMapImage: digestOf("foreman-repo-map"),
          },
        });
        expect(result.stdout).toContain(
          `| foreman-state-api | \`${digestOf("foreman-state-api")}\` |`,
        );
      });

      it("refuses a commit that is not a full commit id", () => {
        const box = sandbox();
        const result = run(box, "build-images.sh", [join(box.root, "images.json")], {
          REGISTRY: "ghcr.io/didi-build",
          COMMIT: "main",
          SOURCE_URL: "https://github.com/didi-build/foreman",
        });
        expect(result.status).toBe(1);
        expect(box.calls()).toEqual([]);
      });
    });
  },
);
