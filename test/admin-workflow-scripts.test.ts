// Integration: the admin workflows' shell scripts (.github/scripts/, D-336, D-339, D-340, O-105)
// run with bash against fake kubectl, tofu, doctl, docker, getent, curl and psql on PATH, so no
// cluster, state, registry, credential, name server, Windmill or database is touched. Every
// value below is made up for the test; every address is a documentation address (RFC 5737).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { readMigrations } from "../src/adapters/store-postgres/migrate.ts";
import { SUPABASE_CA_PATH } from "../src/adapters/store-postgres/tls.ts";
import {
  RENDER_PLACEHOLDER,
  RUN_TIME_KUBERNETES_API,
  filledSettings,
  renderedObjects,
} from "./admin-workflows-fixture.ts";

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
  tool("curl", `exec node ${JSON.stringify(join(FIXTURES, "fake-curl.mjs"))} "$@"`);
  tool("psql", `exec node ${JSON.stringify(join(FIXTURES, "fake-psql.mjs"))} "$@"`);
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
  // `getent ahostsv4 <host>`: one STREAM, DGRAM and RAW line per address in FAKE_GETENT_ADDRESSES
  // (space-separated), as glibc prints them, or exit 2 (not found) when there is none.
  tool(
    "getent",
    [
      'printf "%s\\n" "$*" >>"$FAKE_GETENT_LOG"',
      '[ -n "${FAKE_GETENT_ADDRESSES:-}" ] || exit 2',
      "for a in $FAKE_GETENT_ADDRESSES; do",
      '  printf "%-15s STREAM %s\\n%-15s DGRAM\\n%-15s RAW\\n" "$a" "$2" "$a" "$a"',
      "done",
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
    "getent.log",
    "curl.log",
    "psql.log",
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
      FAKE_GETENT_LOG: join(root, "getent.log"),
      FAKE_CURL_LOG: join(root, "curl.log"),
      FAKE_PSQL_LOG: join(root, "psql.log"),
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

const manifestsFile = (box: Sandbox, objects: unknown = renderedObjects()): string => {
  const path = join(box.root, "manifests.json");
  writeFileSync(path, JSON.stringify(objects));
  return path;
};

/** The log a reader sees: GitHub hides `::add-mask::` lines, and masks their values after. */
const withoutMasks = (stdout: string): string =>
  stdout
    .split("\n")
    .filter((l) => !l.startsWith("::add-mask::"))
    .join("\n");

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

      it("replaces every IPv4 address but 0.0.0.0, side by side too, and leaves version strings as they are (D-349)", () => {
        const lines: [string, string][] = [
          ['ipv4_address = "203.0.113.5"', 'ipv4_address = "<ip>"'],
          [
            "Unable to connect to the server: dial tcp 198.51.100.7:443: i/o timeout",
            "Unable to connect to the server: dial tcp <ip>:443: i/o timeout",
          ],
          ['["198.51.100.7/32","198.51.100.8/32"]', '["<ip>/32","<ip>/32"]'],
          ["203.0.113.5,203.0.113.6 203.0.113.7", "<ip>,<ip> <ip>"],
          [
            "https://203.0.113.8:6443/version [203.0.113.9]",
            "https://<ip>:6443/version [<ip>]",
          ],
          ["connect to 203.0.113.5.", "connect to <ip>."],
          ["::ffff:198.51.100.9 and 0.0.0.1", "::ffff:<ip> and <ip>"],
          [
            'destination_addresses = ["0.0.0.0/0", "::/0"]',
            'destination_addresses = ["0.0.0.0/0", "::/0"]',
          ],
          ["--metrics 0.0.0.0:2000", "--metrics 0.0.0.0:2000"],
          ['except = ["0.0.0.0/8", "10.0.0.0/8"]', 'except = ["0.0.0.0/8", "<ip>/8"]'],
        ];
        const versions = [
          "kubectl v1.37.2 and doctl 1.186.0 installed, checksums verified.",
          'version = "1.37.2-do.0"',
          "- Installing digitalocean/digitalocean v2.68.0...",
          "OpenTofu v1.13.2 on linux_amd64",
          "a four-part v1.2.3.4, a five-part 1.2.3.4.5 and a long 10.0.19041.1",
        ];
        const digest = `ghcr.io/didi-build/foreman-run-watcher@sha256:${"0123456789".repeat(6)}0123`;
        const input = [...lines.map(([from]) => from), ...versions, digest].join("\n");
        const result = run(sandbox(), "redact.sh", [], {}, input);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(
          [...lines.map(([, to]) => to), ...versions, digest].join("\n"),
        );
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
      const SERVER = "https://test-only-cluster.k8s.example.com";
      const HOST = "test-only-cluster.k8s.example.com";
      const RESOLVED = ["203.0.113.20", "203.0.113.21"];
      const credentialEnv = {
        DIGITALOCEAN_ACCESS_TOKEN: "test-only-do-token-0001",
        FAKE_KUBE_TOKEN: "test-only-kube-token-0001",
        CLUSTER_NAME: "foreman",
        CREDENTIAL_SECONDS: "600",
      };
      const credentialBox = (server = SERVER) =>
        sandbox({
          kubeconfigToken: "test-only-kube-token-0001",
          kubeconfigServer: server,
        });

      it("fetches a credential that expires with the job, into a private file, and masks its token", () => {
        const box = credentialBox();
        const result = run(box, "cluster-credential.sh", [], credentialEnv);
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

      it("masks the API server's URL, its host name and each address it resolves to, and prints none of them (D-349)", () => {
        const box = credentialBox(`${SERVER}:6443/`);
        const result = run(box, "cluster-credential.sh", [], {
          ...credentialEnv,
          FAKE_GETENT_ADDRESSES: RESOLVED.join(" "),
        });
        expect(result.status).toBe(0);
        expect(readFileSync(box.env.FAKE_GETENT_LOG as string, "utf8")).toBe(
          `ahostsv4 ${HOST}\n`,
        );
        const masks = result.stdout
          .split("\n")
          .filter((l) => l.startsWith("::add-mask::"));
        expect(masks).toEqual([
          "::add-mask::test-only-kube-token-0001",
          `::add-mask::${SERVER}:6443/`,
          `::add-mask::${HOST}`,
          ...RESOLVED.map((a) => `::add-mask::${a}`),
        ]);
        for (const value of [HOST, ...RESOLVED]) {
          expect(withoutMasks(result.stdout)).not.toContain(value);
          expect(result.stderr).not.toContain(value);
        }
        expect(withoutMasks(result.stdout)).toContain(
          "Short-lived cluster credential fetched",
        );
      });

      it("carries on with a fixed note when the host name does not resolve, still masking the URL and the name", () => {
        const box = credentialBox();
        const result = run(box, "cluster-credential.sh", [], credentialEnv);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`::add-mask::${SERVER}\n::add-mask::${HOST}\n`);
        expect(withoutMasks(result.stdout)).toContain(
          "The cluster's host name does not resolve on this runner, so only the name and the URL are masked.",
        );
        expect(withoutMasks(result.stdout)).not.toContain(HOST);
        expect(result.stderr).not.toContain(HOST);
      });

      it("stops, printing nothing of it, when the credential holds no usable server address", () => {
        for (const server of ["", `${SERVER}\n::warning::injected`]) {
          const result = run(
            credentialBox(server),
            "cluster-credential.sh",
            [],
            credentialEnv,
          );
          expect(result.status, JSON.stringify(server)).toBe(1);
          expect(result.stderr).toContain(
            "::error::The cluster credential holds no usable server address.",
          );
          expect(`${result.stdout}${result.stderr}`).not.toContain(HOST);
        }
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

    describe("api-server-address.sh", () => {
      const ADDRESSES = ["198.51.100.7", "198.51.100.8", "203.0.113.9"];
      const slices = (addresses: unknown[], ports: unknown[]) => ({
        items: [
          {
            addressType: "IPv4",
            endpoints: addresses.map((a) => ({ addresses: [a] })),
            ports,
          },
        ],
      });
      const HTTPS_6443 = [{ name: "https", port: 6443, protocol: "TCP" }];
      const swap = (
        endpointSlices: unknown,
        objects: unknown = renderedObjects(RENDER_PLACEHOLDER),
      ) => {
        const box = sandbox({ endpointSlices });
        const file = manifestsFile(box, objects);
        const before = readFileSync(file, "utf8");
        const result = run(box, "api-server-address.sh", [file]);
        return { box, result, before, after: readFileSync(file, "utf8") };
      };
      /** Every address shows only on mask lines, and those come before any other line. */
      const expectOnlyMasked = (
        stdout: string,
        stderr: string,
        addresses: string[],
      ) => {
        const lines = stdout.split("\n").filter(Boolean);
        const masks = lines.filter((l) => l.startsWith("::add-mask::"));
        expect(lines.slice(0, masks.length)).toEqual(masks);
        for (const address of addresses) {
          expect(masks).toContain(`::add-mask::${address}`);
          expect(withoutMasks(stdout)).not.toContain(address);
          expect(stderr).not.toContain(address);
        }
      };

      it("reads the kubernetes EndpointSlice and puts its addresses and port where the placeholder was", () => {
        const { box, result, after } = swap(slices(ADDRESSES, HTTPS_6443));
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(box.calls().map((c) => c.args)).toEqual([
          [
            "get",
            "endpointslices",
            "-n",
            "default",
            "-l",
            "kubernetes.io/service-name=kubernetes",
            "--output",
            "json",
          ],
        ]);
        // Exactly what the render gives with the real address, and nothing else changed.
        expect(JSON.parse(after)).toEqual(
          JSON.parse(
            JSON.stringify(renderedObjects({ addresses: ADDRESSES, port: 6443 })),
          ),
        );
        expect(after).not.toContain("192.0.2.1/");
        expectOnlyMasked(result.stdout, result.stderr, ADDRESSES);
        expect(withoutMasks(result.stdout).trim()).toBe(
          "The API server's address is in this runner's copy of the rendered objects: 3 address(es).",
        );
      });

      it("refuses an EndpointSlice with no address, an address that is not plain IPv4, or not exactly one port, and changes nothing", () => {
        const cases: [string, unknown[], unknown[]][] = [
          ["no address", [], HTTPS_6443],
          ["IPv6", ["2001:db8::1"], HTTPS_6443],
          ["not an address", ["198.51.100.300"], HTTPS_6443],
          ["0.0.0.0", ["0.0.0.0"], HTTPS_6443],
          [
            "two ports",
            ADDRESSES,
            [...HTTPS_6443, { name: "https", port: 443, protocol: "TCP" }],
          ],
          ["no port", ADDRESSES, []],
          ["DNS's port", ADDRESSES, [{ name: "https", port: 53, protocol: "TCP" }]],
        ];
        for (const [label, addresses, ports] of cases) {
          const { result, before, after } = swap(slices(addresses, ports));
          expect(result.status, label).toBe(1);
          expect(result.stdout, label).toContain(
            "::error::The kubernetes Service's EndpointSlice has no single port and plain IPv4 addresses.",
          );
          expect(after, label).toBe(before);
          expectOnlyMasked(result.stdout, result.stderr, addresses as string[]);
        }
      });

      it("refuses a list it cannot read without quoting any of it", () => {
        const { result, before, after } = swap({ items: "192.0.2.77" });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
          "::error::The kubernetes Service's EndpointSlice list could not be read.",
        );
        expect(`${result.stdout}${result.stderr}`).not.toContain("192.0.2.77");
        expect(after).toBe(before);
      });

      it("refuses when the objects hold no placeholder rule, or more than one, and changes nothing", () => {
        const placeholder = renderedObjects(RENDER_PLACEHOLDER);
        const rule = (
          placeholder.items.find(
            (o) => o.kind === "NetworkPolicy" && o.metadata.name === "run-watcher",
          ) as { spec: { egress: unknown[] } }
        ).spec.egress[1];
        const twice = {
          ...placeholder,
          items: placeholder.items.map((o) =>
            o.kind === "NetworkPolicy" && o.metadata.name === "cloudflared"
              ? { ...o, spec: { ...o.spec, egress: [...o.spec.egress, rule] } }
              : o,
          ),
        };
        const none = swap(slices(ADDRESSES, HTTPS_6443), renderedObjects());
        expect(none.result.status).toBe(1);
        expect(none.result.stdout).toContain(
          "::error::The rendered objects hold no egress rule to the API server's placeholder, so there is nothing to put the address in.",
        );
        expect(none.after).toBe(none.before);
        expectOnlyMasked(none.result.stdout, none.result.stderr, ADDRESSES);
        const two = swap(slices(ADDRESSES, HTTPS_6443), twice);
        expect(two.result.status).toBe(1);
        expect(two.result.stdout).toContain(
          "::error::The rendered objects hold more than one egress rule to the API server's placeholder. Only the run watcher's policy may hold one.",
        );
        expect(two.after).toBe(two.before);
        expectOnlyMasked(two.result.stdout, two.result.stderr, ADDRESSES);
      });

      it("refuses when the placeholder is still in the objects after the swap, and changes nothing", () => {
        const placeholder = renderedObjects(RENDER_PLACEHOLDER);
        const annotated = {
          ...placeholder,
          items: placeholder.items.map((o) =>
            o.kind === "Namespace" && o.metadata.name === "foreman-platform"
              ? {
                  ...o,
                  metadata: { ...o.metadata, annotations: { note: "192.0.2.1" } },
                }
              : o,
          ),
        };
        for (const [label, objects, addresses] of [
          ["elsewhere in the file", annotated, ADDRESSES],
          ["as the address read", placeholder, ["192.0.2.1"]],
        ] as const) {
          const { result, before, after } = swap(
            slices([...addresses], HTTPS_6443),
            objects,
          );
          expect(result.status, label).toBe(1);
          expect(result.stdout, label).toContain(
            "::error::The placeholder for the API server's address is still in the rendered objects after the swap.",
          );
          expect(after, label).toBe(before);
        }
      });
    });

    describe("runner-token.sh", () => {
      const WINDMILL_TOKEN = "test-only-windmill-variables-token-0001";
      const RUNNER_TOKEN = "test-only-runner-head.test-only-runner-body.test-only-sig";
      const ENDPOINT = "https://test-only-cluster.k8s.example.com";
      const CA_PEM =
        "-----BEGIN CERTIFICATE-----\nTESTONLYNOTACERT\n-----END CERTIFICATE-----\n";
      const DESCRIPTION =
        "Written by the Platform workflow's runner-token job (D-352). Run it again rather than editing this by hand.";
      const API = "https://windmill.example.com/api/w/example/variables";

      /** The three Windmill paths flows/windmill.yaml gives the values the runner reads. */
      const description = parseYaml(readFileSync("flows/windmill.yaml", "utf8")) as {
        resources: {
          secrets: { path: string; windmill_path?: string }[];
          values: { name: string; windmill_path?: string }[];
        };
      };
      const PATHS = {
        token: description.resources.secrets.find(
          (s) => s.path === "platform/agent-cluster/runner-token",
        )?.windmill_path as string,
        endpoint: description.resources.values.find(
          (v) => v.name === "agent_cluster_endpoint",
        )?.windmill_path as string,
        ca: description.resources.values.find(
          (v) => v.name === "agent_cluster_ca_certificate",
        )?.windmill_path as string,
      };

      interface CurlCall {
        args: string[];
        headerFiles: string[];
        headers: string[];
        method: string;
        url: string;
        body: string;
        stdin?: string;
      }
      const curlCalls = (box: Sandbox): CurlCall[] =>
        readFileSync(box.env.FAKE_CURL_LOG as string, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as CurlCall);

      interface Variable {
        value: string;
        is_secret: boolean;
        description: string;
      }
      /** The variables the fake Windmill holds (fake-curl.mjs). */
      const storeFile = (box: Sandbox) =>
        `${box.env.FAKE_CURL_LOG as string}.variables`;
      const variables = (box: Sandbox): Record<string, Variable> =>
        existsSync(storeFile(box))
          ? (JSON.parse(readFileSync(storeFile(box), "utf8")) as Record<
              string,
              Variable
            >)
          : {};
      const WRITTEN = (): Record<string, Variable> => ({
        [PATHS.token]: {
          value: RUNNER_TOKEN,
          is_secret: true,
          description: DESCRIPTION,
        },
        [PATHS.endpoint]: {
          value: ENDPOINT,
          is_secret: false,
          description: DESCRIPTION,
        },
        [PATHS.ca]: { value: CA_PEM, is_secret: false, description: DESCRIPTION },
      });

      const tokenBox = (
        state: Record<string, unknown> = {},
        held: Record<string, Variable> = {},
      ) => {
        const box = sandbox({
          kubeconfigServer: ENDPOINT,
          kubeconfigCaData: Buffer.from(CA_PEM).toString("base64"),
          serviceAccounts: ["foreman-runner/foreman-runner"],
          runnerToken: RUNNER_TOKEN,
          tokenFillAfterPolls: 1,
          ...state,
        });
        if (Object.keys(held).length > 0)
          writeFileSync(storeFile(box), JSON.stringify(held));
        return box;
      };

      const tokenRun = (
        box: Sandbox,
        env: Record<string, string> = {},
        settings: unknown = filledSettings(),
      ) => {
        const settingsFile = join(box.root, "settings.json");
        writeFileSync(settingsFile, JSON.stringify(settings));
        return run(box, "runner-token.sh", [], {
          SETTINGS_FILE: settingsFile,
          WINDMILL_RUNNER_RESOURCES_TOKEN: WINDMILL_TOKEN,
          RUNNER_TOKEN_POLL_SECONDS: "0",
          ...env,
        });
      };

      /** Every file left under RUNNER_TEMP, with its content. */
      const leftOver = (box: Sandbox): string[] => {
        const found: string[] = [];
        const walk = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else found.push(readFileSync(path, "utf8"));
          }
        };
        walk(box.env.RUNNER_TEMP as string);
        return found;
      };

      const SECRETS = [WINDMILL_TOKEN, RUNNER_TOKEN, ENDPOINT];
      const expectNothingShown = (
        box: Sandbox,
        result: { stdout: string; stderr: string },
      ) => {
        for (const value of [...SECRETS, "TESTONLYNOTACERT"]) {
          expect(withoutMasks(result.stdout)).not.toContain(value);
          expect(result.stderr).not.toContain(value);
          for (const call of box.calls())
            expect(call.args.join(" ")).not.toContain(value);
          for (const call of curlCalls(box))
            expect(call.args.join(" ")).not.toContain(value);
        }
        // No file holds the Windmill token once the script has ended.
        for (const content of leftOver(box))
          expect(content).not.toContain(WINDMILL_TOKEN);
      };

      /** The log a reader sees, line by line, with the masks left out. */
      const logLines = (stdout: string) =>
        withoutMasks(stdout).split("\n").filter(Boolean);

      /** Each call's method and URL, and the JSON body of each write. */
      const requests = (box: Sandbox) =>
        curlCalls(box).map((c) =>
          c.method === "GET"
            ? [c.method, c.url]
            : [c.method, c.url, JSON.parse(c.body) as unknown],
        );

      it("makes the token Secret for foreman-runner server-side, then on a first run creates three variables at exactly the three Windmill paths, only the token secret", () => {
        const box = tokenBox();
        const result = tokenRun(box);
        expect(result.status).toBe(0);
        expect(PATHS).toEqual({
          token: "f/foreman/platform/agent-cluster/runner-token",
          endpoint: "f/foreman/agent_cluster_endpoint",
          ca: "f/foreman/agent_cluster_ca_certificate",
        });
        const apply = box.calls().filter((c) => c.args[0] === "apply");
        expect(apply).toHaveLength(1);
        expect(apply[0]?.args).toEqual([
          "apply",
          "--server-side",
          "--field-manager=foreman-runner-token",
          "--filename",
          "-",
        ]);
        expect(JSON.parse(apply[0]?.stdin ?? "{}")).toEqual({
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: "foreman-runner-token",
            namespace: "foreman-runner",
            annotations: { "kubernetes.io/service-account.name": "foreman-runner" },
          },
          type: "kubernetes.io/service-account-token",
        });
        // The cluster filled the token in on the second read; the script waited for it.
        expect(
          (box.readState().tokenSecrets as Record<string, { polls: number }>)[
            "foreman-runner-token"
          ]?.polls,
        ).toBe(2);
        // For each path: is it there (no), then create it, with the value itself as its value.
        expect(requests(box)).toEqual([
          ["GET", `${API}/exists/${PATHS.token}`],
          [
            "POST",
            `${API}/create`,
            {
              path: PATHS.token,
              value: RUNNER_TOKEN,
              is_secret: true,
              description: DESCRIPTION,
            },
          ],
          ["GET", `${API}/exists/${PATHS.endpoint}`],
          [
            "POST",
            `${API}/create`,
            {
              path: PATHS.endpoint,
              value: ENDPOINT,
              is_secret: false,
              description: DESCRIPTION,
            },
          ],
          ["GET", `${API}/exists/${PATHS.ca}`],
          [
            "POST",
            `${API}/create`,
            {
              path: PATHS.ca,
              value: CA_PEM,
              is_secret: false,
              description: DESCRIPTION,
            },
          ],
        ]);
        for (const call of curlCalls(box)) {
          expect(call.headers).toEqual(
            call.method === "GET"
              ? [`Authorization: Bearer ${WINDMILL_TOKEN}`]
              : [
                  `Authorization: Bearer ${WINDMILL_TOKEN}`,
                  "Content-Type: application/json",
                ],
          );
          expect(call.headerFiles).toHaveLength(1);
          expect(call.args).toContain("=https");
          if (call.method === "GET") {
            // The check sends nothing: no body, and nothing on its stdin.
            expect(call.body).toBe("");
            expect(call.stdin).toBe("");
          } else {
            expect(call.args).toEqual(
              expect.arrayContaining(["--data-binary", "@-", "--output", "/dev/null"]),
            );
          }
        }
        expect(variables(box)).toEqual(WRITTEN());
        // The log names each path and its status, and nothing else.
        expect(logLines(result.stdout)).toEqual([
          `Created ${PATHS.token} in Windmill (HTTP status 201).`,
          `Created ${PATHS.endpoint} in Windmill (HTTP status 201).`,
          `Created ${PATHS.ca} in Windmill (HTTP status 201).`,
          "The runner's cluster token, the cluster's endpoint and its CA certificate are in Windmill.",
        ]);
      });

      it("shows the Windmill token, the endpoint and the runner's token only on ::add-mask:: lines, never in an argument, and leaves no file holding the Windmill token", () => {
        const box = tokenBox();
        const result = tokenRun(box);
        expect(result.status).toBe(0);
        const masks = result.stdout
          .split("\n")
          .filter((l) => l.startsWith("::add-mask::"));
        expect(masks).toEqual([
          `::add-mask::${WINDMILL_TOKEN}`,
          `::add-mask::${ENDPOINT}`,
          `::add-mask::${RUNNER_TOKEN}`,
        ]);
        // Each mask comes before any other line of the log.
        expect(result.stdout.split("\n").slice(0, 3)).toEqual(masks);
        expectNothingShown(box, result);
      });

      it("applies the same Secret again and updates the three variables on a second run, keeping only the token secret", () => {
        const box = tokenBox({ tokenFillAfterPolls: 0 });
        expect(tokenRun(box).status).toBe(0);
        const firstCalls = curlCalls(box).length;
        const second = tokenRun(box);
        expect(second.status).toBe(0);
        const applies = box.calls().filter((c) => c.args[0] === "apply");
        expect(applies).toHaveLength(2);
        expect(applies[1]).toEqual(applies[0]);
        expect(requests(box).slice(firstCalls)).toEqual([
          ["GET", `${API}/exists/${PATHS.token}`],
          [
            "POST",
            `${API}/update/${PATHS.token}`,
            { value: RUNNER_TOKEN, is_secret: true, description: DESCRIPTION },
          ],
          ["GET", `${API}/exists/${PATHS.endpoint}`],
          [
            "POST",
            `${API}/update/${PATHS.endpoint}`,
            { value: ENDPOINT, is_secret: false, description: DESCRIPTION },
          ],
          ["GET", `${API}/exists/${PATHS.ca}`],
          [
            "POST",
            `${API}/update/${PATHS.ca}`,
            { value: CA_PEM, is_secret: false, description: DESCRIPTION },
          ],
        ]);
        expect(variables(box)).toEqual(WRITTEN());
        expect(logLines(second.stdout)).toEqual([
          `Updated ${PATHS.token} in Windmill (HTTP status 200).`,
          `Updated ${PATHS.endpoint} in Windmill (HTTP status 200).`,
          `Updated ${PATHS.ca} in Windmill (HTTP status 200).`,
          "The runner's cluster token, the cluster's endpoint and its CA certificate are in Windmill.",
        ]);
        expectNothingShown(box, second);
      });

      it("puts a variable made by hand back into its decided shape: the token secret, the others plain", () => {
        const byHand = { description: "made by hand" };
        const box = tokenBox(
          {},
          {
            [PATHS.token]: { ...byHand, value: "test-only-old", is_secret: false },
            [PATHS.ca]: { ...byHand, value: "test-only-old", is_secret: true },
          },
        );
        expect(tokenRun(box).status).toBe(0);
        expect(curlCalls(box).map((c) => `${c.method} ${c.url}`)).toEqual([
          `GET ${API}/exists/${PATHS.token}`,
          `POST ${API}/update/${PATHS.token}`,
          `GET ${API}/exists/${PATHS.endpoint}`,
          `POST ${API}/create`,
          `GET ${API}/exists/${PATHS.ca}`,
          `POST ${API}/update/${PATHS.ca}`,
        ]);
        expect(variables(box)).toEqual(WRITTEN());
      });

      it("refuses any status but 2xx, on the check or on the write, with fixed text, shows none of Windmill's answer, and writes nothing more", () => {
        for (const status of ["302", "400", "401", "403", "404", "500"]) {
          // The endpoint's write fails: the token is written, the CA certificate is not.
          const onWrite = tokenBox();
          const write = tokenRun(onWrite, { FAKE_CURL_STATUSES: `- - - ${status}` });
          expect(write.status, status).toBe(1);
          expect(write.stderr).toContain(
            `::error::Windmill refused writing ${PATHS.endpoint} (HTTP status ${status}). Its answer is not shown, since it could repeat what was sent.`,
          );
          expect(curlCalls(onWrite)).toHaveLength(4);
          expect(Object.keys(variables(onWrite))).toEqual([PATHS.token]);
          // The fake's answer repeats the request: none of it reaches the log.
          expect(`${write.stdout}${write.stderr}`).not.toContain("echo");
          expectNothingShown(onWrite, write);

          // The endpoint's check fails: nothing is written for it.
          const onCheck = tokenBox();
          const check = tokenRun(onCheck, { FAKE_CURL_STATUSES: `- - ${status}` });
          expect(check.status, status).toBe(1);
          expect(check.stderr).toContain(
            `::error::Windmill refused checking ${PATHS.endpoint} (HTTP status ${status}). Its answer is not shown.`,
          );
          expect(curlCalls(onCheck)).toHaveLength(3);
          expect(Object.keys(variables(onCheck))).toEqual([PATHS.token]);
          expect(`${check.stdout}${check.stderr}`).not.toContain("echo");
          expectNothingShown(onCheck, check);
        }
      });

      it("refuses, showing none of it, an answer to the check that is neither true nor false, and writes nothing", () => {
        for (const answer of ["echo", "", "TRUE", "true\nfalse", '{"exists": true}']) {
          const box = tokenBox();
          const result = tokenRun(box, { FAKE_CURL_EXISTS_ANSWER: answer });
          expect(result.status, answer).toBe(1);
          expect(result.stderr).toContain(
            `::error::Windmill's answer to checking ${PATHS.token} is neither true nor false. It is not shown.`,
          );
          expect(curlCalls(box)).toHaveLength(1);
          expect(variables(box)).toEqual({});
          // The echo repeats the request's headers, the Windmill token among them.
          expect(`${result.stdout}${result.stderr}`).not.toContain("echo");
          expectNothingShown(box, result);
        }
      });

      it("never reads an earlier path's answer again when a check answers nothing", () => {
        // The token's check answers false; the endpoint's answers an empty body.
        const box = tokenBox();
        const result = tokenRun(box, { FAKE_CURL_EXISTS_ANSWER: '["false", ""]' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          `::error::Windmill's answer to checking ${PATHS.endpoint} is neither true nor false. It is not shown.`,
        );
        expect(curlCalls(box)).toHaveLength(3);
        expect(Object.keys(variables(box))).toEqual([PATHS.token]);
      });

      it("refuses with fixed text when Windmill cannot be reached, showing no value", () => {
        const box = tokenBox();
        const result = tokenRun(box, { FAKE_CURL_EXIT: "7" });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          `::error::Windmill could not be reached to check ${PATHS.token}`,
        );
        expect(curlCalls(box)).toHaveLength(1);
        expectNothingShown(box, result);
      });

      it("refuses, printing nothing of it, an endpoint, a CA certificate or a token it cannot use, and writes nothing", () => {
        const cases: [Record<string, unknown>, string][] = [
          [
            { kubeconfigServer: `${ENDPOINT}/path` },
            "The cluster credential's server address is not https://host[:port]",
          ],
          [
            { kubeconfigServer: `${ENDPOINT}\n::warning::injected` },
            "The cluster credential's server address is not https://host[:port]",
          ],
          [
            { kubeconfigServer: ENDPOINT.replace("https:", "http:") },
            "The cluster credential's server address is not https://host[:port]",
          ],
          [
            { kubeconfigCaData: Buffer.from("TESTONLYNOTACERT\n").toString("base64") },
            "The cluster credential holds no CA certificate in PEM.",
          ],
          [
            { runnerToken: `${RUNNER_TOKEN}\n::warning::injected` },
            "The Secret foreman-runner/foreman-runner-token holds no usable token.",
          ],
          [
            { runnerToken: "test-only-not-a-jwt" },
            "The Secret foreman-runner/foreman-runner-token holds no usable token.",
          ],
        ];
        for (const [state, message] of cases) {
          const box = tokenBox(state);
          const result = tokenRun(box);
          expect(result.status, message).toBe(1);
          expect(result.stderr).toContain(`::error::${message}`);
          expect(curlCalls(box)).toEqual([]);
          expect(`${result.stdout}${result.stderr}`).not.toContain("::warning::");
          expect(`${result.stdout}${result.stderr}`).not.toContain(
            "test-only-not-a-jwt",
          );
          expectNothingShown(box, result);
        }
      });

      it("refuses when the service account is not there yet, or the cluster never fills in the token", () => {
        const noAccount = tokenBox({ serviceAccounts: [] });
        const first = tokenRun(noAccount);
        expect(first.status).toBe(1);
        expect(first.stderr).toContain(
          "::error::The service account foreman-runner/foreman-runner is not there: apply the platform objects first",
        );
        expect(noAccount.calls().filter((c) => c.args[0] === "apply")).toEqual([]);
        expect(curlCalls(noAccount)).toEqual([]);

        const neverFilled = tokenBox({ runnerToken: "" });
        const second = tokenRun(neverFilled);
        expect(second.status).toBe(1);
        expect(second.stderr).toContain(
          "::error::The cluster did not fill in the Secret foreman-runner/foreman-runner-token with a token in time.",
        );
        expect(
          (neverFilled.readState().tokenSecrets as Record<string, { polls: number }>)[
            "foreman-runner-token"
          ]?.polls,
        ).toBe(30);
        expect(curlCalls(neverFilled)).toEqual([]);
      });

      it("refuses a Windmill token that is missing or holds a newline, and a settings file without a usable Windmill host or workspace, before reaching the cluster", () => {
        const filled = filledSettings() as unknown as {
          platform: { windmill: { host: string; workspace: string } };
        };
        const withWindmill = (host: string, workspace: string) => ({
          ...filled,
          platform: { ...filled.platform, windmill: { host, workspace } },
        });
        const cases: [Record<string, string>, unknown, string][] = [
          [
            { WINDMILL_RUNNER_RESOURCES_TOKEN: "" },
            filled,
            "WINDMILL_RUNNER_RESOURCES_TOKEN is not set in the platform environment",
          ],
          [
            {
              WINDMILL_RUNNER_RESOURCES_TOKEN: `${WINDMILL_TOKEN}\n::warning::injected`,
            },
            filled,
            "WINDMILL_RUNNER_RESOURCES_TOKEN holds a space, a newline or a control character",
          ],
          [{}, withWindmill("", "example"), "windmill.host in the settings file"],
          [
            {},
            withWindmill("https://windmill.example.com", "example"),
            "windmill.host in the settings file",
          ],
          [
            {},
            withWindmill("192.0.2.1", "example"),
            "windmill.host in the settings file",
          ],
          [
            {},
            withWindmill("windmill.example.com", ""),
            "windmill.workspace in the settings file",
          ],
          [
            {},
            withWindmill("windmill.example.com", "bad/workspace"),
            "windmill.workspace in the settings file",
          ],
        ];
        for (const [env, settings, message] of cases) {
          const box = tokenBox();
          const result = tokenRun(box, env, settings);
          expect(result.status, message).toBe(1);
          expect(result.stderr).toContain(`::error::${message}`);
          expect(`${result.stdout}${result.stderr}`).not.toContain("::warning::");
          expect(box.calls()).toEqual([]);
          expect(curlCalls(box)).toEqual([]);
        }
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
        const result = run(box, "platform-checks.sh", [manifestsFile(box), "network"]);
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
          // The API server's address and port come from the run watcher's policy (D-349).
          expect(JSON.parse(pod.spec.containers[0]?.env[0]?.value ?? "[]")).toEqual([
            { host: "1.1.1.1", port: 443 },
            ...RUN_TIME_KUBERNETES_API.addresses.map((host) => ({
              host,
              port: RUN_TIME_KUBERNETES_API.port,
            })),
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

      it("probes every API server address on its own port, as the swapped file gives them", () => {
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
        const api = { addresses: ["198.51.100.7", "198.51.100.8"], port: 6443 };
        const result = run(box, "platform-checks.sh", [
          manifestsFile(box, renderedObjects(api)),
          "network",
        ]);
        expect(result.status).toBe(0);
        const created = box.readState().created as {
          spec: { containers: { env: { value: string }[] }[] };
        }[];
        expect(created).toHaveLength(2);
        for (const pod of created) {
          expect(JSON.parse(pod.spec.containers[0]?.env[0]?.value ?? "[]")).toEqual([
            { host: "1.1.1.1", port: 443 },
            { host: "198.51.100.7", port: 6443 },
            { host: "198.51.100.8", port: 6443 },
          ]);
        }
      });

      it("refuses to probe the render's placeholder in place of the API server's address", () => {
        const box = sandbox({ nodes });
        const result = run(box, "platform-checks.sh", [
          manifestsFile(box, renderedObjects(RENDER_PLACEHOLDER)),
          "network",
        ]);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
          "| the API server's address is in the rendered objects | yes | no | **FAILED** |",
        );
        expect(box.readState().created).toBeUndefined();
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
        expect(result.stdout).toContain("**DNS change** (DNS gate, D-195, D-357)");
        expect(result.stdout).toContain("**Deletes or replaces**");
        expect(result.stdout).toContain("**Spending**");
        expect(result.stdout).not.toContain("**Network rules**");
        expect(result.stdout).toContain(
          "| create | `module.edge.cloudflare_dns_record.receiver[0]` |",
        );
        expect(result.stdout).not.toContain("digitalocean_firewall.workers");
        expect(result.stdout).toContain('resource "cloudflare_dns_record" "receiver"');
      });

      /** The bullet lines under the gates, each record or route that changes by name. */
      const named = (stdout: string): string[] =>
        (
          /### Gates this plan touches\n([\s\S]*?)\n### Resources that change/.exec(
            stdout,
          )?.[1] ?? ""
        )
          .split("\n")
          .filter((line) => line.startsWith("  - "));

      it("lists each project's record and route that changes by name under its gate, from the workflow's own reading of the plan (D-357, O-112)", () => {
        // The plan job's filter over the plan's JSON form: addresses, types and actions only.
        const infraApply = parseYaml(
          readFileSync(".github/workflows/infra-apply.yml", "utf8"),
        ) as { jobs: { plan: { steps: { id?: string; run?: string }[] } } };
        const planRun =
          infraApply.jobs.plan.steps.find((s) => s.id === "plan")?.run ?? "";
        const filter = /show -json plan\.out \|\s*jq -c '([^']+)'/.exec(planRun)?.[1];
        expect(filter).toBeDefined();
        const jq = spawnSync(
          "jq",
          ["-c", filter ?? "", join(FIXTURES, "infra-plan-projects.json")],
          { encoding: "utf8" },
        );
        expect(jq.status).toBe(0);
        const result = summarize(JSON.parse(jq.stdout) as unknown[]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("- **DNS change** (DNS gate, D-195, D-357)");
        expect(result.stdout).toContain("- **Workers route change** (DNS gate, D-357)");
        expect(result.stdout).toContain("`<slug>-staging`");
        expect(result.stdout).toContain("- **Deletes or replaces**");
        expect(named(result.stdout)).toEqual([
          "  - delete `old-project.example.com`",
          "  - create `rehearsal.example.com`",
          "  - create `shop-2.example.com`",
          "  - delete `old-project.example.com/*`",
          "  - create `rehearsal.example.com/*`",
          "  - create `shop-2.example.com/*`",
        ]);
        expect(result.stdout).toContain(
          '| create | `module.edge.cloudflare_workers_route.project["rehearsal.example.com"]` |',
        );
        // The receiver's record does not change here, and nothing but addresses was read.
        expect(result.stdout).not.toContain("cloudflare_dns_record.receiver");
        expect(result.stdout).not.toContain("hooks.example.com");
        expect(result.stdout).not.toContain("fedcba9876543210fedcba9876543210");
      });

      it("names the receiver's record by its address and any other change by its address", () => {
        const result = summarize([
          {
            address: "module.edge.cloudflare_dns_record.receiver[0]",
            type: "cloudflare_dns_record",
            actions: ["create"],
          },
          {
            address: 'module.edge.cloudflare_dns_record.project["Not A Host"]',
            type: "cloudflare_dns_record",
            actions: ["update"],
          },
        ]);
        expect(result.status).toBe(0);
        expect(named(result.stdout)).toEqual([
          "  - create the receiver's record `module.edge.cloudflare_dns_record.receiver[0]` (its host name is a placeholder in the plan below)",
          '  - update `module.edge.cloudflare_dns_record.project["Not A Host"]`',
        ]);
        expect(result.stdout).not.toContain("**Workers route change**");
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

    describe("db-migrate.sh", () => {
      // Made up for the test: a user shaped like the session pooler's (`postgres.<project ref>`),
      // a password that needs percent-encoding, and a documentation host name.
      const user = "postgres.abcdefghijklmnopqrst";
      const password = "p@ss%w0rd:9/x";
      const encoded = encodeURIComponent(password);
      const host = "db.example.com";
      const url = [
        "postgresql://",
        user,
        ":",
        encoded,
        "@",
        host,
        ":6543/postgres",
      ].join("");
      /** What must never show outside an `::add-mask::` line. */
      const values = [url, encoded, password, user, host];

      const FILES: Record<string, string> = {
        "0001_first.sql": "create table one (id int);\n",
        // psql would read these as a backslash command and a variable; the server must get them
        // as they are, as migrate.ts sends them.
        "0002_second.sql":
          "-- \\gexec and :name stay text.\ncreate table two (note text default ':name \\o');\n",
        "0003_Upper.sql": "-- not a migration name, so never applied\n",
        "README.md": "not a migration\n",
      };
      const MIGRATION_NAMES = ["0001_first.sql", "0002_second.sql"];

      function folder(box: Sandbox, files: Record<string, string> = FILES): string {
        const dir = join(box.root, "migrations");
        mkdirSync(dir, { recursive: true });
        for (const [name, content] of Object.entries(files)) {
          writeFileSync(join(dir, name), content);
        }
        return dir;
      }

      const reportPath = (box: Sandbox) => join(box.root, "report.md");
      const report = (box: Sandbox) =>
        existsSync(reportPath(box)) ? readFileSync(reportPath(box), "utf8") : "";

      function migrate(box: Sandbox, env: Record<string, string> = {}, dir?: string) {
        return run(box, "db-migrate.sh", [dir ?? folder(box)], {
          MIGRATION_DATABASE_URL: url,
          REPORT: reportPath(box),
          ...env,
        });
      }

      interface PsqlCall {
        args: string[];
        env: Record<string, string>;
        passFileExists: boolean | null;
        script: string;
      }
      const psqlCalls = (box: Sandbox): PsqlCall[] =>
        readFileSync(join(box.root, "psql.log"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as PsqlCall);
      /** The one call that runs the migrations' script (the check runs no script, O-118). */
      const migrateCalls = (box: Sandbox): PsqlCall[] =>
        psqlCalls(box).filter((call) => call.args.includes("-f"));
      const checkCalls = (box: Sandbox): PsqlCall[] =>
        psqlCalls(box).filter((call) => !call.args.includes("-f"));

      /** The log line, and the summary's, once the database refused a connection without TLS. */
      const CHECKED = "Checked first: the database refuses a connection without TLS.\n";

      function expectNoValueShown(
        result: { stdout: string; stderr: string },
        shown: string[] = values,
      ) {
        for (const out of [withoutMasks(result.stdout), result.stderr]) {
          for (const value of shown) expect(out).not.toContain(value);
        }
      }

      const escapeRegExp = (text: string) =>
        text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      /** GitHub reads `%0D`, `%0A` and `%25` in a command's value as CR, LF and `%`. */
      const asGitHubReadsIt = (mask: string) =>
        mask
          .slice("::add-mask::".length)
          .replaceAll("%0D", "\r")
          .replaceAll("%0A", "\n")
          .replaceAll("%25", "%");

      it("masks the connection string, its password, user and host before anything else, so GitHub masks each value itself", () => {
        const box = sandbox();
        const result = migrate(box, { FAKE_PSQL_MODE: "fresh" });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const lines = result.stdout.split("\n");
        const masks = lines.filter((l) => l.startsWith("::add-mask::"));
        expect(lines.slice(0, masks.length)).toEqual(masks);
        expect(masks.map(asGitHubReadsIt)).toEqual([
          url,
          encoded,
          user,
          host,
          password,
        ]);
        // Each % goes as %25, so the mask is not read as another value.
        expect(masks[1]).toBe(`::add-mask::${encoded.replaceAll("%", "%25")}`);
        expectNoValueShown(result);
        expect(withoutMasks(result.stdout)).toBe(
          `${CHECKED}Applied: 0001_first.sql, 0002_second.sql\n`,
        );
      });

      it("gives psql the connection only in its environment, with TLS verified against the committed CA certificate and no PG setting inherited", () => {
        const box = sandbox();
        const result = migrate(box, {
          PGOPTIONS: "-c search_path=elsewhere",
          PGSERVICE: "elsewhere",
          PGSSLMODE: "disable",
          PGSSLROOTCERT: "/elsewhere/any-ca.crt",
          PGGSSENCMODE: "require",
          PGHOST: "elsewhere.example.com",
          PGPASSFILE: "/dev/null",
          PGPASSWORD: "inherited-not-it",
        });
        expect(result.status).toBe(0);
        const calls = psqlCalls(box);
        expect(calls).toHaveLength(2);
        const [check, call] = calls as [PsqlCall, PsqlCall];
        expect(check.args).toEqual(["-X", "-q", "-w", "-c", "select 1"]);
        expect(call.env).toEqual({
          PGHOST: host,
          PGPORT: "6543",
          PGUSER: user,
          PGPASSWORD: password,
          PGDATABASE: "postgres",
          PGSSLMODE: "verify-full",
          PGSSLROOTCERT: "src/adapters/store-postgres/supabase-ca.crt",
          PGGSSENCMODE: "disable",
          PGCLIENTENCODING: "UTF8",
          PGCONNECT_TIMEOUT: "30",
          PGAPPNAME: "foreman-db-migrate",
        });
        expect(call.args).toEqual([
          "-X",
          "-q",
          "-w",
          "--set=ON_ERROR_STOP=1",
          "-f",
          expect.stringMatching(
            /\/runner-temp\/db-migrate\.[A-Za-z0-9]+\/migrate\.psql$/,
          ),
        ]);
        for (const value of values) {
          expect(call.args.join(" ")).not.toContain(value);
          expect(call.script).not.toContain(value);
        }
        // The generated script is removed with its folder.
        expect(readdirSync(box.env.RUNNER_TEMP as string)).toEqual([]);
      });

      it("takes Postgres's port when the connection string names none", () => {
        const box = sandbox();
        const result = migrate(box, {
          MIGRATION_DATABASE_URL: url.replace(":6543/", "/"),
        });
        expect(result.status).toBe(0);
        expect(psqlCalls(box).map((call) => call.env.PGPORT)).toEqual(["5432", "5432"]);
      });

      it("checks first, with no password in the call, that the database refuses a connection without TLS (O-118)", () => {
        const box = sandbox();
        // An inherited password and password file, which must not reach the check.
        writeFileSync(join(box.root, "a-password-file"), "*:*:*:*:inherited-not-it\n");
        const result = migrate(box, {
          FAKE_PSQL_MODE: "fresh",
          PGPASSWORD: "inherited-not-it",
          PGPASSFILE: join(box.root, "a-password-file"),
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const [check, ...rest] = psqlCalls(box) as [PsqlCall, ...PsqlCall[]];
        expect(rest).toEqual(migrateCalls(box));
        expect(rest).toHaveLength(1);
        expect(check.args).toEqual(["-X", "-q", "-w", "-c", "select 1"]);
        expect(check.env).toEqual({
          PGHOST: host,
          PGPORT: "6543",
          PGUSER: user,
          PGDATABASE: "postgres",
          PGPASSFILE: expect.stringMatching(
            /\/runner-temp\/db-migrate\.[A-Za-z0-9]+\/no-password-file$/,
          ),
          PGSSLMODE: "disable",
          PGGSSENCMODE: "disable",
          PGCONNECT_TIMEOUT: "30",
          PGAPPNAME: "foreman-db-migrate-tls-check",
        });
        // No password reaches the call: not in its environment, and no password file exists.
        expect(check.env).not.toHaveProperty("PGPASSWORD");
        expect(check.passFileExists).toBe(false);
        for (const value of [password, encoded, url, "inherited-not-it"]) {
          expect(JSON.stringify(check), value).not.toContain(value);
        }
        // The refusal quotes the host and the user, and is not shown when the check passes.
        expect(withoutMasks(result.stdout)).toBe(
          `${CHECKED}Applied: 0001_first.sql, 0002_second.sql\n`,
        );
        expectNoValueShown(result);
      });

      it("passes the check on Postgres's own wordings of the refusal, met on a direct connection, beside an address that does not answer", () => {
        // Supabase's docs show "SSL off"; PostgreSQL 16 prints "no encryption".
        for (const wording of ["SSL off", "no encryption"]) {
          const box = sandbox();
          const result = migrate(box, {
            FAKE_PSQL_CHECK_STDERR: [
              `psql: error: connection to server at "${host}" (192.0.2.7), port 6543 failed: Connection refused`,
              "\tIs the server running on that host and accepting TCP/IP connections?",
              `connection to server at "${host}" (192.0.2.9), port 6543 failed: FATAL:  no pg_hba.conf entry for host "192.0.2.8", user "${user}", database "postgres", ${wording}`,
              "",
            ].join("\n"),
          });
          expect(result.stderr, wording).toBe("");
          expect(result.status, wording).toBe(0);
          expect(withoutMasks(result.stdout), wording).toBe(
            `${CHECKED}Nothing to apply.\n`,
          );
          expect(migrateCalls(box), wording).toHaveLength(1);
        }
      });

      it("stops before any migration when the database asks a connection without TLS for a password, or lets it in: enforcement is off", () => {
        const off = `::error::Supabase's "Enforce SSL on incoming connections" is off: `;
        const cases: [string, Record<string, string>, string[]][] = [
          [
            "asks for a password",
            {
              FAKE_PSQL_CHECK_STDERR: `psql: error: connection to server at "${host}" (192.0.2.7), port 6543 failed: fe_sendauth: no password supplied\n`,
            },
            [
              'psql: error: connection to server at "<DATABASE_HOST>" (<ip>), port 6543 failed: fe_sendauth: no password supplied',
              `${off}the database asked a connection without TLS for a password, and none was sent. Turn it on (first-hosting runbook step 9a), then run this job again. Nothing was applied.`,
            ],
          ],
          [
            "lets it in",
            { FAKE_PSQL_CHECK_STDERR: "", FAKE_PSQL_CHECK_STATUS: "0" },
            [
              `${off}the database let in a connection without TLS. Turn it on (first-hosting runbook step 9a), then run this job again. Nothing was applied.`,
            ],
          ],
          [
            "asks one address for a password after another refused",
            {
              FAKE_PSQL_CHECK_STDERR: [
                `psql: error: connection to server at "${host}" (192.0.2.7), port 6543 failed: FATAL:  no pg_hba.conf entry for host "192.0.2.8", user "${user}", database "postgres", SSL off`,
                `connection to server at "${host}" (192.0.2.9), port 6543 failed: fe_sendauth: no password supplied`,
                "",
              ].join("\n"),
            },
            [
              'psql: error: connection to server at "<DATABASE_HOST>" (<ip>), port 6543 failed: FATAL:  no pg_hba.conf entry for host "<ip>", user "<DATABASE_USER>", database "postgres", SSL off',
              'connection to server at "<DATABASE_HOST>" (<ip>), port 6543 failed: fe_sendauth: no password supplied',
              `${off}the database asked a connection without TLS for a password, and none was sent. Turn it on (first-hosting runbook step 9a), then run this job again. Nothing was applied.`,
            ],
          ],
        ];
        for (const [label, env, stderr] of cases) {
          const box = sandbox();
          const result = migrate(box, { FAKE_PSQL_MODE: "fresh", ...env });
          expect(result.status, label).toBe(1);
          expect(result.stderr, label).toBe(`${stderr.join("\n")}\n`);
          expect(withoutMasks(result.stdout), label).toBe("");
          expect(checkCalls(box), label).toHaveLength(1);
          expect(migrateCalls(box), label).toEqual([]);
          expect(report(box), label).toBe(
            `## Database migrations\n\nStopped: ${(stderr.at(-1) as string).slice("::error::".length)}\n`,
          );
          expectNoValueShown(result);
        }
      });

      it("stops before any migration on any other answer to the check, showing psql's error only redacted", () => {
        const at = `connection to server at "${host}" (192.0.2.7), port 6543 failed: `;
        const refusal = `${at}FATAL:  no pg_hba.conf entry for host "192.0.2.8", user "${user}", database "postgres", SSL off`;
        const cases: [string, string, string][] = [
          ["a timeout", `psql: error: ${at}timeout expired\n`, "2"],
          ["no answer at all", "", "2"],
          [
            "the refusal beside another server error",
            `psql: error: ${refusal}\n${at}FATAL:  Tenant or user not found\n`,
            "2",
          ],
          ["the refusal with another exit status", `psql: error: ${refusal}\n`, "1"],
          [
            "SSL off without the pg_hba.conf refusal",
            `psql: error: ${at}FATAL:  SSL off\n`,
            "2",
          ],
          ["the refusal with more after it", `psql: error: ${refusal}, or not\n`, "2"],
          [
            "a refusal of a connection with SSL",
            `psql: error: ${refusal.replace("SSL off", "SSL encryption")}\n`,
            "2",
          ],
          [
            "the pooler's refusal with more after it",
            `psql: error: ${at}FATAL:  (ESSLREQUIRED) SSL connection is required for user: postgres, or not\n`,
            "2",
          ],
          [
            "the pooler's wording without its code",
            `psql: error: ${at}FATAL:  SSL connection is required for user: postgres\n`,
            "2",
          ],
          [
            "the pooler's refusal beside another of its errors",
            `psql: error: ${at}FATAL:  (ESSLREQUIRED) SSL connection is required for user: postgres\n${at}FATAL:  (ETENANTNOTFOUND) Tenant or user not found\n`,
            "2",
          ],
        ];
        for (const [label, checkStderr, checkStatus] of cases) {
          const box = sandbox();
          const result = migrate(box, {
            FAKE_PSQL_MODE: "fresh",
            FAKE_PSQL_CHECK_STDERR: checkStderr,
            FAKE_PSQL_CHECK_STATUS: checkStatus,
          });
          expect(result.status, label).toBe(1);
          expect(result.stderr, label).toMatch(
            /\n?::error::The check that the database refuses a connection without TLS did not end in the refusal it expects, so nothing was applied\. psql's error, redacted, is above \(first-hosting runbook step 9a\)\.\n$/,
          );
          if (checkStderr !== "") {
            expect(result.stderr, label).toContain(
              'connection to server at "<DATABASE_HOST>" (<ip>), port 6543 failed: ',
            );
          }
          expect(withoutMasks(result.stdout), label).toBe("");
          expect(migrateCalls(box), label).toEqual([]);
          expect(report(box), label).toContain(
            "Stopped: The check that the database refuses a connection without TLS did not end in the refusal it expects",
          );
          expectNoValueShown(result);
        }
      });

      it("refuses with fixed text, before psql runs, a CA certificate file that is missing or is not PEM certificates, and takes one or more PEM certificates", () => {
        const committed = readFileSync(SUPABASE_CA_PATH, "utf8");
        const [, body = ""] =
          /-----BEGIN CERTIFICATE-----\n([\s\S]+?)-----END CERTIFICATE-----/.exec(
            committed,
          ) ?? [];
        /** The script run from another checkout's root, with this at the certificate's path. */
        function migrateFrom(ca: string | null | "folder") {
          const box = sandbox();
          const checkout = join(box.root, "checkout");
          const path = join(checkout, SUPABASE_CA_PATH);
          mkdirSync(join(path, ".."), { recursive: true });
          if (ca === "folder") mkdirSync(path);
          else if (ca !== null) writeFileSync(path, ca);
          const done = spawnSync(
            "bash",
            [join(SCRIPTS, "db-migrate.sh"), folder(box)],
            {
              cwd: checkout,
              encoding: "utf8",
              env: { ...box.env, MIGRATION_DATABASE_URL: url, REPORT: reportPath(box) },
            },
          );
          return { box, status: done.status, stdout: done.stdout, stderr: done.stderr };
        }
        const missing = `::error::The database CA certificate is missing at ${SUPABASE_CA_PATH}.\n`;
        const notPem = `::error::The database CA certificate at ${SUPABASE_CA_PATH} is not a PEM certificate.\n`;
        const refused: [string, string | null | "folder", string][] = [
          ["no file", null, missing],
          ["a folder", "folder", missing],
          ["an empty file", "", notPem],
          ["text", "not a certificate\n", notPem],
          [
            "a public key",
            `-----BEGIN PUBLIC KEY-----\n${body}-----END PUBLIC KEY-----\n`,
            notPem,
          ],
          ["a certificate with text after it", `${committed}trust me too\n`, notPem],
          ["a certificate with text before it", `subject=CN = x\n${committed}`, notPem],
          [
            "a certificate with a character base64 does not have",
            committed.replace(body, `${body.slice(0, 10)}!${body.slice(11)}`),
            notPem,
          ],
          [
            "an unfinished certificate",
            committed.replace("-----END CERTIFICATE-----", ""),
            notPem,
          ],
          [
            "an empty certificate",
            "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n",
            notPem,
          ],
          [
            "base64 that does not decode",
            "-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n",
            notPem,
          ],
        ];
        for (const [label, ca, error] of refused) {
          const result = migrateFrom(ca);
          expect(result.status, label).toBe(1);
          expect(result.stderr, label).toBe(error);
          expect(psqlCalls(result.box), label).toEqual([]);
          expect(report(result.box), label).toContain(
            `Stopped: ${error.slice("::error::".length, -1)}`,
          );
        }
        const taken: [string, string][] = [
          ["the committed certificate", committed],
          [
            "two certificates, as during a switch to a new root",
            `${committed}${committed}`,
          ],
          [
            "Windows line ends and blank lines",
            `\n${committed.replaceAll("\n", "\r\n")}\n\n`,
          ],
          ["no line end after the last line", committed.trimEnd()],
        ];
        for (const [label, ca] of taken) {
          const result = migrateFrom(ca);
          expect(result.stderr, label).toBe("");
          expect(result.status, label).toBe(0);
          expect(migrateCalls(result.box)[0]?.env.PGSSLROOTCERT, label).toBe(
            SUPABASE_CA_PATH,
          );
        }
      });

      it("runs one script in one session: the lock, migrate.ts's setup, the recorded rows read once, then each file with its record in its own transaction, then the unlock", () => {
        const box = sandbox();
        const dir = folder(box);
        expect(migrate(box, {}, dir).status).toBe(0);
        const lines = (migrateCalls(box)[0] as PsqlCall).script.split("\n");
        const gexec =
          /^select convert_from\(decode\('([A-Za-z0-9+/=]*)', 'base64'\), 'UTF8'\) \\gexec$/;
        const decoded = (line: string | undefined) =>
          Buffer.from(gexec.exec(line ?? "")?.[1] ?? "", "base64").toString("utf8");

        expect(lines.slice(0, 5)).toEqual([
          "\\set ON_ERROR_STOP on",
          "\\set AUTOCOMMIT on",
          "\\set ON_ERROR_ROLLBACK off",
          "\\o /dev/null",
          "select pg_advisory_lock(7104001);",
        ]);
        expect(lines[5]).toMatch(gexec);
        expect(decoded(lines[5])).toContain(
          "create schema if not exists factory_meta;",
        );
        expect(lines.filter((l) => l.includes("pg_advisory_lock("))).toHaveLength(1);
        expect(lines.some((l) => /^\\(c|connect)\b/.test(l))).toBe(false);
        // The recorded rows are read in one statement, before the first file.
        const read = lines.indexOf("\\gset");
        expect(lines.filter((l) => l === "\\gset")).toHaveLength(1);
        expect(read).toBeLessThan(lines.indexOf("begin;"));

        // Each file the rule picks, in name order: refuse if changed, else apply if pending, its
        // text decoded byte for byte, with its record in the same transaction.
        const sha = (name: string) =>
          createHash("sha256")
            .update(readFileSync(join(dir, name)))
            .digest("hex");
        let at = read + 1;
        expect(lines.slice(at, at + 5)).toEqual([
          "\\if :missing",
          "select pg_advisory_unlock(7104001);",
          "\\echo missing :missing_name",
          "\\q",
          "\\endif",
        ]);
        at += 5;
        MIGRATION_NAMES.forEach((name, i) => {
          expect(lines.slice(at, at + 5), name).toEqual([
            `\\if :changed_${i}`,
            "select pg_advisory_unlock(7104001);",
            `\\echo changed ${name}`,
            "\\q",
            "\\endif",
          ]);
          at += 5;
          expect(lines.slice(at, at + 4), name).toEqual([
            `\\if :pending_${i}`,
            `\\echo applying ${name}`,
            "begin;",
            expect.stringMatching(gexec),
          ]);
          expect(decoded(lines[at + 3]), name).toBe(FILES[name]);
          at += 4;
          expect(lines.slice(at, at + 4), name).toEqual([
            `insert into factory_meta.schema_migrations (name, sha256) values ('${name}', '${sha(name)}');`,
            "commit;",
            `\\echo applied ${name}`,
            "\\endif",
          ]);
          at += 4;
          const snapshot = lines.slice(0, read).join("\n");
          expect(snapshot, name).toContain(
            `not exists (select from factory_meta.schema_migrations where name = '${name}') as pending_${i}`,
          );
          expect(snapshot, name).toContain(
            `exists (select from factory_meta.schema_migrations where name = '${name}' and sha256 <> '${sha(name)}') as changed_${i}`,
          );
        });
        expect(lines.slice(at)).toEqual([
          "select pg_advisory_unlock(7104001);",
          "\\echo done",
          "",
        ]);
        expect(lines.join("\n")).toContain(
          "where not (name = any (array['0001_first.sql', '0002_second.sql']::text[]))",
        );
      });

      it("says Nothing to apply when every file is recorded, in the log and the summary", () => {
        const box = sandbox();
        const result = migrate(box, { FAKE_PSQL_STDOUT: "done\n" });
        expect(result.status).toBe(0);
        expect(withoutMasks(result.stdout)).toBe(`${CHECKED}Nothing to apply.\n`);
        expect(report(box)).toBe(
          `## Database migrations\n\n${CHECKED}\nNothing to apply: every migration is recorded.\n`,
        );
      });

      it("lists the migrations applied in the summary, names only", () => {
        const box = sandbox();
        expect(migrate(box, { FAKE_PSQL_MODE: "fresh" }).status).toBe(0);
        expect(report(box)).toBe(
          [
            "## Database migrations",
            "",
            CHECKED.trimEnd(),
            "",
            "Applied, in order:",
            "",
            "- `0001_first.sql`",
            "- `0002_second.sql`",
            "",
            "Every migration is recorded.",
            "",
          ].join("\n"),
        );
      });

      it("names the migration that failed as rolled back, after those applied before it, with psql's error shown", () => {
        const box = sandbox();
        const result = migrate(box, {
          FAKE_PSQL_STDOUT:
            "applying 0001_first.sql\napplied 0001_first.sql\napplying 0002_second.sql\n",
          FAKE_PSQL_STDERR:
            'psql:/tmp/migrate.psql:20: ERROR:  relation "two" already exists\n',
          FAKE_PSQL_STATUS: "3",
        });
        expect(result.status).toBe(1);
        expect(withoutMasks(result.stdout)).toBe(`${CHECKED}Applied: 0001_first.sql\n`);
        expect(result.stderr).toBe(
          [
            'psql:/tmp/migrate.psql:20: ERROR:  relation "two" already exists',
            "::error::0002_second.sql failed and was rolled back; nothing after it was applied. psql's error, redacted, is above.",
            "",
          ].join("\n"),
        );
        expect(report(box)).toContain("- `0001_first.sql`\n");
        expect(report(box)).toContain(
          "Stopped: 0002_second.sql failed and was rolled back; nothing after it was applied.",
        );
      });

      it("shows psql's own errors only redacted, since a connection error can quote the host and the user", () => {
        const box = sandbox();
        const result = migrate(box, {
          FAKE_PSQL_STDOUT: "",
          FAKE_PSQL_STDERR: [
            `psql: error: connection to server at "${host}" (192.0.2.7), port 6543 failed: FATAL:  password authentication failed for user "${user}"`,
            `and once more: ${url} ${encoded} ${password}`,
            "",
          ].join("\n"),
          FAKE_PSQL_STATUS: "2",
        });
        expect(result.status).toBe(1);
        expectNoValueShown(result);
        expect(result.stderr).toBe(
          [
            'psql: error: connection to server at "<DATABASE_HOST>" (<ip>), port 6543 failed: FATAL:  password authentication failed for user "<DATABASE_USER>"',
            "and once more: <MIGRATION_DATABASE_URL> <DATABASE_PASSWORD_ENCODED> <DATABASE_PASSWORD>",
            "::error::psql stopped (exit status 2) before the end, with nothing more applied. psql's error, redacted, is above.",
            "",
          ].join("\n"),
        );
      });

      it("refuses as migrate.ts does when a recorded file changed or is missing, after what was applied before", () => {
        const cases: [string, string][] = [
          [
            "changed 0001_first.sql\n",
            "::error::0001_first.sql changed after it was applied. Add a new migration instead of editing it.",
          ],
          [
            "applying 0001_first.sql\napplied 0001_first.sql\nchanged 0002_second.sql\n",
            "::error::0002_second.sql changed after it was applied. Add a new migration instead of editing it.",
          ],
          [
            "missing 0005_gone.sql\n",
            "::error::0005_gone.sql is recorded as applied but its file is missing.",
          ],
          [
            "missing -\n",
            "::error::A row whose name is not a migration file name is recorded as applied, and no file has that name.",
          ],
        ];
        for (const [stdout, error] of cases) {
          const box = sandbox();
          const result = migrate(box, { FAKE_PSQL_STDOUT: stdout });
          expect(result.status, stdout).toBe(1);
          expect(result.stderr, stdout).toBe(`${error}\n`);
          expect(withoutMasks(result.stdout), stdout).toBe(
            CHECKED +
              (stdout.startsWith("applying") ? "Applied: 0001_first.sql\n" : ""),
          );
          expect(report(box), stdout).toContain(
            `Stopped: ${error.slice("::error::".length)}`,
          );
        }
      });

      it("stops, showing none of it, on a line psql is not expected to print, and when psql ends before the end", () => {
        const unexpected = [
          `applying 0001_first.sql\n${user} says hello\n`,
          "applied 0001_first.sql\n",
          "applying 0001_first.sql\napplying 0002_second.sql\n",
          "applying 0001_first.sql\ndone\n",
          "applying ../0001_first.sql\n",
        ];
        for (const stdout of unexpected) {
          const box = sandbox();
          const result = migrate(box, { FAKE_PSQL_STDOUT: stdout });
          expect(result.status, stdout).toBe(1);
          expect(result.stderr, stdout).toBe(
            "::error::psql printed a line this script does not expect, so the run stopped. The line is not shown, since it could hold a value.\n",
          );
          expectNoValueShown(result);
          expect(withoutMasks(result.stdout), stdout).not.toContain("says hello");
        }
        const box = sandbox();
        const result = migrate(box, {
          FAKE_PSQL_STDOUT: "applying 0001_first.sql\napplied 0001_first.sql\n",
        });
        expect(result.status).toBe(1);
        expect(withoutMasks(result.stdout)).toBe(`${CHECKED}Applied: 0001_first.sql\n`);
        expect(result.stderr).toBe(
          "::error::psql stopped (exit status 0) before the end, with nothing more applied. psql's error, redacted, is above.\n",
        );
      });

      it("refuses with fixed text, before psql runs, a connection string it cannot use", () => {
        const shape =
          "::error::MIGRATION_DATABASE_URL is not postgresql://user:password@host:port/database";
        const characters =
          "::error::MIGRATION_DATABASE_URL holds a space, a newline or a control character";
        const cases: [string, string][] = [
          [
            "",
            "::error::MIGRATION_DATABASE_URL is not set in the database environment",
          ],
          [url.replace("postgres.", "postgres "), characters],
          [`${url}\n`, characters],
          [url.replace("@", "\t@"), characters],
          [url.replace("@", "\u0001@"), characters],
          [url.replace("@", "\u007f@"), characters],
          [url.replace("postgresql://", "mysql://"), shape],
          [url.replace(`:${encoded}@`, "@"), shape],
          [url.replace(`:${encoded}@`, ":@"), shape],
          [`${url}?sslmode=disable`, shape],
          [`${url}#fragment`, shape],
          [url.replace(encoded, "p@ss"), shape],
          [url.replace(encoded, "p/ss"), shape],
          [url.replace("/postgres", ""), shape],
          [url.replace(host, "[2001:db8::1]"), shape],
          [url.replace(":6543", ":0"), "::error::The port in MIGRATION_DATABASE_URL"],
          [
            url.replace(":6543", ":65536"),
            "::error::The port in MIGRATION_DATABASE_URL",
          ],
          [
            url.replace(encoded, "p%0Ass"),
            "::error::The password in MIGRATION_DATABASE_URL",
          ],
          [
            url.replace(encoded, "p%7Fss"),
            "::error::The password in MIGRATION_DATABASE_URL",
          ],
          [
            url.replace(encoded, "p%zzss"),
            "::error::The password in MIGRATION_DATABASE_URL",
          ],
          [
            url.replace(encoded, "pass%4"),
            "::error::The password in MIGRATION_DATABASE_URL",
          ],
          [
            url.replace(user, "postgres%00"),
            "::error::The user in MIGRATION_DATABASE_URL",
          ],
        ];
        for (const [value, error] of cases) {
          const box = sandbox();
          const result = migrate(box, { MIGRATION_DATABASE_URL: value });
          const label = JSON.stringify(value);
          expect(result.status, label).toBe(1);
          expect(result.stderr, label).toMatch(
            new RegExp(`^${escapeRegExp(error)}[^\\n]*\\n$`),
          );
          expect(psqlCalls(box), label).toEqual([]);
          if (value !== "")
            expectNoValueShown(result, [value, "p%0Ass", "p@ss", "postgres%00"]);
          // A value it cannot check is never even masked, so no half of it reaches a mask line.
          if (error === characters || value === "")
            expect(result.stdout, label).toBe("");
          expect(report(box), label).toContain(
            `Stopped: ${error.slice("::error::".length)}`,
          );
        }
      });

      it("refuses a migrations folder that is missing, or a migration name that is not a file", () => {
        const box = sandbox();
        const missing = migrate(box, {}, join(box.root, "nowhere"));
        expect(missing.status).toBe(1);
        expect(missing.stderr).toMatch(
          /^::error::The migrations folder \S+ is missing\.\n$/,
        );
        const dir = folder(box);
        mkdirSync(join(dir, "0003_a_folder.sql"));
        const notAFile = migrate(box, {}, dir);
        expect(notAFile.status).toBe(1);
        expect(notAFile.stderr).toMatch(
          /^::error::0003_a_folder\.sql in \S+ is not a file\.\n$/,
        );
        expect(psqlCalls(box)).toEqual([]);
      });

      it("hashes each file's bytes, which for every migration in db/migrations is migrate.ts's hash of its UTF-8 text", () => {
        const files = readMigrations();
        expect(files.length).toBeGreaterThan(20);
        for (const file of files) {
          const path = join("db/migrations", file.name);
          const bytes = readFileSync(path);
          // Valid UTF-8, so reading it as text and encoding it again gives the same bytes.
          expect(
            () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            file.name,
          ).not.toThrow();
          const sum = spawnSync("sha256sum", { input: bytes, encoding: "utf8" });
          expect(sum.stdout.split(/\s+/)[0], file.name).toBe(file.sha256);
        }
      });
    });
  },
);
