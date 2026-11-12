import { describe, expect, it } from "vitest";

import { secretEnvName } from "../../../service-kit/config.ts";
import {
  COUNCIL,
  DEVELOPER,
  GITHUB_TOKEN,
  LIMITS,
  MODEL_KEY,
  MODEL_SECRET_PATH,
  OPENCODE_IMAGE,
  QA,
  QA_LIMITS,
  SETTINGS,
  STATE_TOKEN,
  credentialsFor,
  taskFor,
} from "./fixtures.ts";
import {
  AGENTS_POOL,
  REPO_MAP_HOSTS,
  agentStage,
  checkRunSpec,
  checkSettings,
  fetchStage,
  repoMapSecret,
  repoMapStage,
  runSecrets,
  taskSecret,
  workspaceClaim,
  type KubernetesRunSpec,
  type RepoMapJobSpec,
} from "./manifests.ts";
import { LABEL_RUN_ID, repoMapNames, runNames } from "./names.ts";
import type { EnvVar, Job, NetworkPolicy, RunObject } from "./objects.ts";

// Unit: the run's manifests as pure functions (ADR 0106 sections 2 to 6). No cluster.

const PROXY_IP = "10.245.0.10";

/** One repo map read (D-275 (2)). */
const REPO_MAP: RepoMapJobSpec = {
  mapId: "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
  projectSlug: "rehearsal",
  repository: "didi-build/rehearsal",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  mode: "map",
};

/** The same Job in the Scanner's scan mode (O-92), with its own read id. */
const REPO_SCAN: RepoMapJobSpec = {
  ...REPO_MAP,
  mapId: "8b7c6d5e-4f3a-4b2c-8d9e-0f1a2b3c4d5e",
  mode: "scan",
};

function envOf(job: Job): Map<string, EnvVar> {
  const container = job.spec.template.spec.containers[0];
  return new Map((container?.env ?? []).map((e) => [e.name, e]));
}

function value(job: Job, name: string): string | undefined {
  const entry = envOf(job).get(name);
  return entry && "value" in entry ? entry.value : undefined;
}

function secretRefs(job: Job): string[] {
  return [...envOf(job).values()].flatMap((e) =>
    "valueFrom" in e ? [e.valueFrom.secretKeyRef.name] : [],
  );
}

/** Every Job of every kind of run, with the objects around them. */
function everything(): { jobs: Job[]; objects: RunObject[] } {
  const dev = agentStage(DEVELOPER, LIMITS, SETTINGS);
  const council = agentStage(COUNCIL, LIMITS, SETTINGS);
  const qa = agentStage(QA, QA_LIMITS, SETTINGS);
  const fetch = fetchStage(QA, SETTINGS);
  const repoMap = repoMapStage(REPO_MAP, SETTINGS);
  const repoScan = repoMapStage(REPO_SCAN, SETTINGS);
  const stages = [dev, council, qa, fetch, repoMap, repoScan];
  const jobs = stages.flatMap((s) => [s.proxyJob, s.clientJob(PROXY_IP)]);
  const objects: RunObject[] = [
    ...jobs,
    ...stages.flatMap((s) => [...s.policies, s.proxyService]),
    ...runSecrets(DEVELOPER, credentialsFor(DEVELOPER)),
    ...runSecrets(QA, credentialsFor(QA)),
    ...runSecrets(COUNCIL, credentialsFor(COUNCIL)),
    repoMapSecret(REPO_MAP, GITHUB_TOKEN),
    repoMapSecret(REPO_SCAN, GITHUB_TOKEN),
    workspaceClaim(QA, SETTINGS),
  ];
  return { jobs, objects };
}

describe("run pods (unit: pod hardening, ADR 0106 section 4)", () => {
  const { jobs } = everything();

  it.each(jobs.map((job) => [job.metadata.name, job] as const))(
    "%s has every security field",
    (_name, job) => {
      const pod = job.spec.template.spec;
      expect(pod.securityContext).toMatchObject({
        runAsNonRoot: true,
        runAsUser: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      });
      expect(pod.automountServiceAccountToken).toBe(false);
      expect(pod.hostNetwork).toBe(false);
      expect(pod.hostPID).toBe(false);
      expect(pod.hostIPC).toBe(false);
      expect(pod.enableServiceLinks).toBe(false);
      expect(pod.nodeSelector).toEqual({ [AGENTS_POOL.key]: AGENTS_POOL.value });
      expect(pod.tolerations).toEqual([
        {
          key: AGENTS_POOL.key,
          operator: "Equal",
          value: AGENTS_POOL.value,
          effect: "NoSchedule",
        },
      ]);
      expect(pod.containers).toHaveLength(1);
      for (const container of pod.containers) {
        expect(container.securityContext).toEqual({
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          readOnlyRootFilesystem: true,
          allowPrivilegeEscalation: false,
          privileged: false,
          capabilities: { drop: ["ALL"] },
          seccompProfile: { type: "RuntimeDefault" },
        });
        for (const kind of ["requests", "limits"] as const) {
          expect(Object.keys(container.resources[kind]).sort()).toEqual([
            "cpu",
            "ephemeral-storage",
            "memory",
          ]);
        }
        expect(container.image).toMatch(/@sha256:[0-9a-f]{64}$/);
      }
      // Only emptyDir, the run's own claim and the run's own task Secret: never a host path.
      for (const volume of pod.volumes) {
        expect(Object.keys(volume).sort()).toSatisfy(
          (keys: string[]) =>
            JSON.stringify(keys) === '["emptyDir","name"]' ||
            JSON.stringify(keys) === '["name","persistentVolumeClaim"]' ||
            JSON.stringify(keys) === '["name","secret"]',
        );
        if ("secret" in volume) {
          expect(volume.secret.secretName).toMatch(/^run-[a-z0-9-]+-task$/);
        }
      }
      expect(JSON.stringify(job)).not.toContain("hostPath");
    },
  );
});

describe("run Jobs (unit: budgets enforced by Kubernetes, ADR 0106 section 6)", () => {
  it("sets the deadline from maxMinutes, no retries, the grace period and a TTL", () => {
    const job = agentStage(DEVELOPER, LIMITS, SETTINGS).clientJob(PROXY_IP);
    expect(job.spec.activeDeadlineSeconds).toBe(50 * 60);
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.template.spec.restartPolicy).toBe("Never");
    expect(job.spec.ttlSecondsAfterFinished).toBe(3600);
    expect(job.spec.template.spec.terminationGracePeriodSeconds).toBe(30);
    expect(value(job, "FOREMAN_MAX_TURNS")).toBe("100");
    expect(value(job, "FOREMAN_MAX_BUDGET_USD")).toBe("5");
  });

  it("gives the proxy a little longer than its agent, and a ceiling of twice the turns", () => {
    const { proxyJob } = agentStage(QA, QA_LIMITS, SETTINGS);
    expect(proxyJob.spec.activeDeadlineSeconds).toBe(20 * 60 + 30 + 120);
    expect(proxyJob.spec.backoffLimit).toBe(0);
    expect(value(proxyJob, "MAX_MODEL_REQUESTS")).toBe("100");
  });

  it("gives the agent its tier, minute limit and Flex retries, and the proxy its rejected-request ceiling (ADR 0114 section 9)", () => {
    const spec = { ...QA, serviceTier: "flex" as const, flexCapacityRetries: 2 };
    const stage = agentStage(
      { ...spec, maxRejectedModelRequests: 4 },
      QA_LIMITS,
      SETTINGS,
    );
    const agent = stage.clientJob(PROXY_IP);
    expect(value(agent, "FOREMAN_SERVICE_TIER")).toBe("flex");
    expect(JSON.parse(value(agent, "FOREMAN_MODEL_PRICE") ?? "")).toEqual(QA.price);
    expect(value(agent, "FOREMAN_MAX_MINUTES")).toBe("20");
    expect(value(agent, "FOREMAN_FLEX_CAPACITY_RETRIES")).toBe("2");
    expect(value(stage.proxyJob, "MAX_REJECTED_MODEL_REQUESTS")).toBe("4");
    expect(
      value(fetchStage(QA, SETTINGS).proxyJob, "MAX_REJECTED_MODEL_REQUESTS"),
    ).toBe("1");
  });

  it("gives the fetch step its own deadline", () => {
    const fetch = fetchStage(QA, SETTINGS);
    expect(fetch.clientJob(PROXY_IP).spec.activeDeadlineSeconds).toBe(600);
    expect(fetch.proxyJob.spec.activeDeadlineSeconds).toBe(600 + 30 + 120);
  });
});

describe("run credentials (unit: mounted only where needed, ADR 0106 section 5)", () => {
  const names = (spec: KubernetesRunSpec) => runNames(spec.runId);

  it("never gives the QA pod the GitHub token, and mounts its tree read-only", () => {
    const qaJob = agentStage(QA, QA_LIMITS, SETTINGS).clientJob(PROXY_IP);
    expect(secretRefs(qaJob)).toEqual([names(QA).stateTokenSecret]);
    expect(envOf(qaJob).has("GITHUB_TOKEN")).toBe(false);
    const pod = qaJob.spec.template.spec;
    expect(pod.volumes).toContainEqual({
      name: "workspace",
      persistentVolumeClaim: { claimName: names(QA).workspaceClaim, readOnly: true },
    });
    expect(pod.containers[0]?.volumeMounts).toContainEqual({
      name: "workspace",
      mountPath: "/workspace",
      readOnly: true,
    });
  });

  it("gives the GitHub token to the fetch pod, which writes the tree", () => {
    const fetchJob = fetchStage(QA, SETTINGS).clientJob(PROXY_IP);
    expect(secretRefs(fetchJob)).toEqual([names(QA).githubTokenSecret]);
    expect(fetchJob.spec.template.spec.containers[0]?.volumeMounts).toContainEqual({
      name: "workspace",
      mountPath: "/workspace",
      readOnly: false,
    });
  });

  it("gives the Developer its GitHub and state API tokens, and Council only the state token", () => {
    const dev = agentStage(DEVELOPER, LIMITS, SETTINGS).clientJob(PROXY_IP);
    expect(secretRefs(dev).sort()).toEqual(
      [names(DEVELOPER).githubTokenSecret, names(DEVELOPER).stateTokenSecret].sort(),
    );
    const council = agentStage(COUNCIL, LIMITS, SETTINGS).clientJob(PROXY_IP);
    expect(secretRefs(council)).toEqual([names(COUNCIL).stateTokenSecret]);
  });

  it("mounts the task file read-only into the agent pod only, readable by its group", () => {
    for (const spec of [DEVELOPER, QA, COUNCIL]) {
      const stage = agentStage(spec, LIMITS, SETTINGS);
      const agent = stage.clientJob(PROXY_IP).spec.template.spec;
      expect(agent.volumes).toContainEqual({
        name: "task",
        secret: {
          secretName: names(spec).taskSecret,
          items: [{ key: "task.json", path: "task.json" }],
          defaultMode: 0o440,
        },
      });
      expect(agent.containers[0]?.volumeMounts).toContainEqual({
        name: "task",
        mountPath: "/task",
        readOnly: true,
      });
      expect(value(stage.clientJob(PROXY_IP), "FOREMAN_TASK_FILE")).toBe(
        "/task/task.json",
      );
      expect(JSON.stringify(stage.proxyJob)).not.toContain("-task");
    }
    expect(JSON.stringify(fetchStage(QA, SETTINGS).clientJob(PROXY_IP))).not.toContain(
      names(QA).taskSecret,
    );
  });

  it("checks the task file for its role before building its Secret", () => {
    const secret = taskSecret(QA, taskFor(QA));
    expect(secret.metadata.name).toBe(names(QA).taskSecret);
    expect(JSON.parse(secret.stringData["task.json"] ?? "")).toEqual(taskFor(QA));
    expect(() => taskSecret(QA, { ...taskFor(QA), nodeId: "not-a-uuid" })).toThrow(
      /node id/,
    );
    expect(() =>
      taskSecret(COUNCIL, { ...taskFor(COUNCIL), outputSchema: undefined }),
    ).toThrow(/output schema/);
    expect(() =>
      taskSecret(COUNCIL, { ...taskFor(COUNCIL), allowedTools: ["Bash"] }),
    ).toThrow(/no Claude Code tools/);
    expect(() =>
      taskSecret(DEVELOPER, { ...taskFor(DEVELOPER), input: "x".repeat(950 * 1024) }),
    ).toThrow(/too large/);
  });

  it("mounts the model credential into the proxy pod only", () => {
    for (const spec of [DEVELOPER, QA, COUNCIL]) {
      const stage = agentStage(spec, spec === QA ? QA_LIMITS : LIMITS, SETTINGS);
      expect(secretRefs(stage.proxyJob)).toEqual([names(spec).modelSecret]);
      expect(envOf(stage.proxyJob).get(secretEnvName(MODEL_SECRET_PATH))).toEqual({
        name: secretEnvName(MODEL_SECRET_PATH),
        valueFrom: {
          secretKeyRef: {
            name: names(spec).modelSecret,
            key: secretEnvName(MODEL_SECRET_PATH),
          },
        },
      });
      expect(secretRefs(stage.clientJob(PROXY_IP))).not.toContain(
        names(spec).modelSecret,
      );
    }
    expect(secretRefs(fetchStage(QA, SETTINGS).proxyJob)).toEqual([]);
  });

  it("puts values only in Secrets, never in any other object", () => {
    const secrets = runSecrets(DEVELOPER, credentialsFor(DEVELOPER));
    expect(secrets.map((s) => [s.metadata.name, Object.keys(s.stringData)])).toEqual([
      [names(DEVELOPER).stateTokenSecret, ["token"]],
      [names(DEVELOPER).modelSecret, [secretEnvName(MODEL_SECRET_PATH)]],
      [names(DEVELOPER).githubTokenSecret, ["token"]],
    ]);
    expect(secrets.every((s) => s.immutable)).toBe(true);
    const others = everything().objects.filter((o) => o.kind !== "Secret");
    const text = JSON.stringify(others);
    for (const secret of [MODEL_KEY, STATE_TOKEN, GITHUB_TOKEN]) {
      expect(text).not.toContain(secret);
    }
  });

  it("refuses a missing model credential or a GitHub token for a run that holds none", () => {
    expect(() =>
      runSecrets(DEVELOPER, { ...credentialsFor(DEVELOPER), models: {} }),
    ).toThrow(/credential for provider anthropic is missing/);
    expect(() =>
      runSecrets(COUNCIL, { ...credentialsFor(COUNCIL), githubToken: GITHUB_TOKEN }),
    ).toThrow(/holds no GitHub token/);
    expect(() =>
      runSecrets(QA, { ...credentialsFor(QA), githubToken: undefined }),
    ).toThrow(/needs its GitHub token/);
  });
});

describe("run network (unit: per-run NetworkPolicies, ADR 0106 section 2, D-195)", () => {
  const policy = (stage: { policies: NetworkPolicy[] }, i: number) =>
    stage.policies[i] as NetworkPolicy;

  it("lets the agent pod reach only its own proxy, with no DNS and no ingress", () => {
    const stage = agentStage(DEVELOPER, LIMITS, SETTINGS);
    const agent = policy(stage, 0);
    expect(agent.spec.podSelector).toEqual({
      matchLabels: { [LABEL_RUN_ID]: DEVELOPER.runId, "foreman/component": "agent" },
    });
    expect(agent.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(agent.spec.ingress).toEqual([]);
    expect(agent.spec.egress).toEqual([
      {
        to: [
          {
            podSelector: {
              matchLabels: {
                [LABEL_RUN_ID]: DEVELOPER.runId,
                "foreman/component": "proxy",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
    ]);
    // The proxy's own pods carry the labels the policy selects.
    expect(stage.proxyJob.spec.template.metadata.labels).toMatchObject(
      agent.spec.egress[0]?.to[0]?.podSelector?.matchLabels ?? { missing: "selector" },
    );
    // The agent reaches the proxy by IP address: it needs no DNS.
    const job = stage.clientJob(PROXY_IP);
    expect(value(job, "HTTPS_PROXY")).toBe(`http://${PROXY_IP}:8080`);
    expect(value(job, "ANTHROPIC_BASE_URL")).toBe(`http://${PROXY_IP}:8080/anthropic`);
    expect(value(job, "FOREMAN_STATE_API_URL")).toBe(
      `http://${PROXY_IP}:8080/state-api`,
    );
  });

  it("lets the proxy accept only its agent, and reach DNS, public 443 and the state API", () => {
    const proxy = policy(agentStage(DEVELOPER, LIMITS, SETTINGS), 1);
    expect(proxy.spec.ingress).toEqual([
      {
        from: [
          {
            podSelector: {
              matchLabels: {
                [LABEL_RUN_ID]: DEVELOPER.runId,
                "foreman/component": "agent",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
    ]);
    const [dns, publicEgress, stateApi, ...rest] = proxy.spec.egress;
    expect(rest).toEqual([]);
    expect(dns?.ports.map((p) => `${p.protocol}/${p.port}`)).toEqual([
      "UDP/53",
      "TCP/53",
    ]);
    expect(dns?.to[0]?.namespaceSelector?.matchLabels).toEqual({
      "kubernetes.io/metadata.name": "kube-system",
    });
    expect(publicEgress?.ports).toEqual([{ protocol: "TCP", port: 443 }]);
    const block = publicEgress?.to[0]?.ipBlock;
    expect(block?.cidr).toBe("0.0.0.0/0");
    for (const range of [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
    ]) {
      expect(block?.except).toContain(range);
    }
    expect(stateApi).toEqual({
      to: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": "foreman-platform" },
          },
          podSelector: { matchLabels: { app: "state-api" } },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    });
  });

  it("gives QA a proxy with no CONNECT host, and its fetch step a proxy with GitHub only", () => {
    const qa = agentStage(QA, QA_LIMITS, SETTINGS);
    expect(value(qa.proxyJob, "ALLOWED_HOSTS")).toBe("");
    expect(value(qa.proxyJob, "STATE_API_UPSTREAM")).toBe(SETTINGS.stateApi.upstream);
    const fetch = fetchStage(QA, SETTINGS);
    expect(value(fetch.proxyJob, "ALLOWED_HOSTS")).toBe(
      "api.github.com,codeload.github.com",
    );
    expect(value(fetch.proxyJob, "MODEL_PROVIDERS")).toBe("[]");
    expect(value(fetch.proxyJob, "STATE_API_UPSTREAM")).toBe("");
    // The fetch proxy's policy has DNS and 443 but no state API.
    expect(policy(fetch, 1).spec.egress).toHaveLength(2);
    // The fetch pod reaches only the fetch proxy, not the QA proxy.
    expect(policy(fetch, 0).spec.egress[0]?.to[0]?.podSelector?.matchLabels).toEqual({
      [LABEL_RUN_ID]: QA.runId,
      "foreman/component": "fetch-proxy",
    });
  });

  it("puts a ClusterIP Service in front of each proxy, selecting only that proxy", () => {
    const { proxyService } = agentStage(DEVELOPER, LIMITS, SETTINGS);
    expect(proxyService.spec).toEqual({
      type: "ClusterIP",
      selector: { [LABEL_RUN_ID]: DEVELOPER.runId, "foreman/component": "proxy" },
      ports: [{ name: "proxy", protocol: "TCP", port: 8080, targetPort: 8080 }],
    });
  });
});

describe("the repo map Job (unit: D-275 (2), O-87)", () => {
  const stage = repoMapStage(REPO_MAP, SETTINGS);
  const n = repoMapNames(REPO_MAP.mapId);
  const mapJob = stage.clientJob(PROXY_IP);

  it("runs the repo map image with its own deadline, no retries, the grace period and a short TTL", () => {
    expect(mapJob.metadata.name).toBe(n.job);
    expect(mapJob.spec.template.spec.containers[0]?.image).toBe(SETTINGS.repoMapImage);
    expect(mapJob.spec.activeDeadlineSeconds).toBe(SETTINGS.repoMapMaxMinutes * 60);
    expect(mapJob.spec.backoffLimit).toBe(0);
    expect(mapJob.spec.template.spec.restartPolicy).toBe("Never");
    expect(mapJob.spec.ttlSecondsAfterFinished).toBe(SETTINGS.ttlSecondsAfterFinished);
    expect(mapJob.spec.template.spec.terminationGracePeriodSeconds).toBe(
      SETTINGS.terminationGracePeriodSeconds,
    );
    expect(mapJob.spec.template.spec.containers[0]?.resources).toEqual(
      SETTINGS.resources.repoMap,
    );
    expect(stage.proxyJob.spec.activeDeadlineSeconds).toBe(
      SETTINGS.repoMapMaxMinutes * 60 +
        SETTINGS.terminationGracePeriodSeconds +
        SETTINGS.proxyDeadlineMarginSeconds,
    );
  });

  it("gives the Job the read token and no other credential: no state API, no model, no task", () => {
    expect(secretRefs(mapJob)).toEqual([n.githubTokenSecret]);
    expect(envOf(mapJob).get("GITHUB_TOKEN")).toEqual({
      name: "GITHUB_TOKEN",
      valueFrom: { secretKeyRef: { name: n.githubTokenSecret, key: "token" } },
    });
    expect([...envOf(mapJob).keys()].sort()).toEqual([
      "FOREMAN_COMMIT_SHA",
      "FOREMAN_JOB_MODE",
      "FOREMAN_REPOSITORY",
      "FOREMAN_RUN_ID",
      "GITHUB_TOKEN",
      "HTTPS_PROXY",
      "NO_PROXY",
      "TMPDIR",
      "https_proxy",
      "no_proxy",
    ]);
    expect(value(mapJob, "FOREMAN_REPOSITORY")).toBe(REPO_MAP.repository);
    expect(value(mapJob, "FOREMAN_COMMIT_SHA")).toBe(REPO_MAP.commitSha);
    expect(value(mapJob, "HTTPS_PROXY")).toBe(`http://${PROXY_IP}:8080`);
    // Its proxy holds no credential at all.
    expect(secretRefs(stage.proxyJob)).toEqual([]);
    // Only a scratch /tmp: no task Secret, no workspace claim.
    expect(mapJob.spec.template.spec.volumes).toEqual([
      { name: "tmp", emptyDir: { sizeLimit: SETTINGS.scratchSizeLimit } },
    ]);
    const secret = repoMapSecret(REPO_MAP, GITHUB_TOKEN);
    expect(secret.metadata.name).toBe(n.githubTokenSecret);
    expect(secret.stringData).toEqual({ token: GITHUB_TOKEN });
    expect(secret.immutable).toBe(true);
    expect(JSON.stringify([stage.proxyJob, mapJob, ...stage.policies])).not.toContain(
      GITHUB_TOKEN,
    );
  });

  it("reaches GitHub only: its pod only its own proxy, the proxy only DNS and public 443, and only GitHub's hosts", () => {
    expect([...REPO_MAP_HOSTS]).toEqual(["api.github.com", "codeload.github.com"]);
    expect(value(stage.proxyJob, "ALLOWED_HOSTS")).toBe(
      "api.github.com,codeload.github.com",
    );
    expect(value(stage.proxyJob, "MODEL_PROVIDERS")).toBe("[]");
    expect(value(stage.proxyJob, "STATE_API_UPSTREAM")).toBe("");
    const [client, proxy] = stage.policies;
    expect(client.spec.ingress).toEqual([]);
    expect(client.spec.egress).toEqual([
      {
        to: [
          {
            podSelector: {
              matchLabels: {
                [LABEL_RUN_ID]: REPO_MAP.mapId,
                "foreman/component": "repo-map-proxy",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
    ]);
    expect(proxy.spec.ingress[0]?.from).toEqual([
      {
        podSelector: {
          matchLabels: {
            [LABEL_RUN_ID]: REPO_MAP.mapId,
            "foreman/component": "repo-map",
          },
        },
      },
    ]);
    // DNS and public 443 only: no state API, no private range.
    expect(proxy.spec.egress).toHaveLength(2);
    expect(proxy.spec.egress[1]?.to[0]?.ipBlock?.except).toContain("10.0.0.0/8");
    expect(stage.proxyService.spec.selector).toEqual({
      [LABEL_RUN_ID]: REPO_MAP.mapId,
      "foreman/component": "repo-map-proxy",
    });
  });

  it("labels its objects with the read's id and the repo-map role, under names apart from runs", () => {
    for (const object of [
      stage.proxyJob,
      mapJob,
      stage.proxyService,
      ...stage.policies,
      repoMapSecret(REPO_MAP, GITHUB_TOKEN),
    ]) {
      expect(object.metadata.labels?.["foreman/role"]).toBe("repo-map");
      expect(object.metadata.labels?.[LABEL_RUN_ID]).toBe(REPO_MAP.mapId);
      expect(object.metadata.name).toMatch(/^map-/);
    }
  });

  it.each<[string, Partial<RepoMapJobSpec>]>([
    ["a bad id", { mapId: "Not An Id" }],
    ["a bad project slug", { projectSlug: "Bad_Slug" }],
    ["a bad repository", { repository: "../x" }],
    ["a short commit", { commitSha: "abc" }],
    ["an unknown mode", { mode: "run" as RepoMapJobSpec["mode"] }],
  ])("refuses %s", (_label, change) => {
    expect(() => repoMapStage({ ...REPO_MAP, ...change }, SETTINGS)).toThrow();
    expect(() => repoMapSecret({ ...REPO_MAP, ...change }, GITHUB_TOKEN)).toThrow();
  });

  it("refuses an empty token, an unpinned image and a bad deadline", () => {
    expect(() => repoMapSecret(REPO_MAP, "")).toThrow(/read token/);
    expect(() =>
      checkSettings({
        ...SETTINGS,
        repoMapImage: "registry.example.com/repo-map:latest",
      }),
    ).toThrow(/repo map image must be pinned by digest/);
    expect(() => checkSettings({ ...SETTINGS, repoMapMaxMinutes: 0 })).toThrow(
      /repoMapMaxMinutes/,
    );
  });
});

describe("the scan Job (unit: the repo map Job in scan mode, D-300, O-92)", () => {
  /** The object with its read's id replaced, so two reads' objects compare. */
  const strip = <T>(object: T, id: string): T =>
    JSON.parse(JSON.stringify(object).split(id).join("ID")) as T;

  it("is the repo map Job with only its mode changed: same image, deadline, resources, credential and network", () => {
    const map = repoMapStage(REPO_MAP, SETTINGS);
    const scan = repoMapStage(REPO_SCAN, SETTINGS);
    const scanJob = scan.clientJob(PROXY_IP);
    expect(value(scanJob, "FOREMAN_JOB_MODE")).toBe("scan");
    expect(value(map.clientJob(PROXY_IP), "FOREMAN_JOB_MODE")).toBe("map");
    const mapJob = strip(map.clientJob(PROXY_IP), REPO_MAP.mapId);
    const sameJob = strip(scanJob, REPO_SCAN.mapId);
    const container = sameJob.spec.template.spec.containers[0];
    const mapContainer = mapJob.spec.template.spec.containers[0];
    expect({
      ...sameJob,
      spec: {
        ...sameJob.spec,
        template: {
          ...sameJob.spec.template,
          spec: {
            ...sameJob.spec.template.spec,
            containers: [
              {
                ...container,
                env: container?.env?.filter((e) => e.name !== "FOREMAN_JOB_MODE"),
              },
            ],
          },
        },
      },
    }).toEqual({
      ...mapJob,
      spec: {
        ...mapJob.spec,
        template: {
          ...mapJob.spec.template,
          spec: {
            ...mapJob.spec.template.spec,
            containers: [
              {
                ...mapContainer,
                env: mapContainer?.env?.filter((e) => e.name !== "FOREMAN_JOB_MODE"),
              },
            ],
          },
        },
      },
    });
    expect(strip(scan.proxyJob, REPO_SCAN.mapId)).toEqual(
      strip(map.proxyJob, REPO_MAP.mapId),
    );
    expect(scan.policies.map((p) => strip(p, REPO_SCAN.mapId))).toEqual(
      map.policies.map((p) => strip(p, REPO_MAP.mapId)),
    );
    expect(secretRefs(scanJob)).toEqual([
      repoMapNames(REPO_SCAN.mapId).githubTokenSecret,
    ]);
    expect(value(scan.proxyJob, "ALLOWED_HOSTS")).toBe(REPO_MAP_HOSTS.join(","));
  });
});

describe("run objects (unit: labels, names and determinism)", () => {
  it("labels every object with its run id, project and role", () => {
    for (const object of everything().objects) {
      const labels = object.metadata.labels ?? {};
      expect(labels[LABEL_RUN_ID]).toMatch(/^[0-9a-f-]{36}$/);
      expect(labels["foreman/project"]).toBe("rehearsal");
      expect(labels["app.kubernetes.io/managed-by"]).toBe("foreman-runner");
      expect(object.metadata.namespace).toBe("agents-rehearsal");
      expect(object.metadata.name.length).toBeLessThanOrEqual(63);
    }
  });

  it("gives the OpenCode image its provider's API and the proxy's address for it (D-222)", () => {
    const agent = agentStage(DEVELOPER, LIMITS, SETTINGS).clientJob(PROXY_IP);
    expect(agent.spec.template.spec.containers[0]?.image).toBe(OPENCODE_IMAGE);
    expect(value(agent, "FOREMAN_MODEL_API")).toBe("anthropic");
    expect(value(agent, "FOREMAN_MODEL_BASE_URL")).toBe(
      `http://${PROXY_IP}:8080/anthropic/v1`,
    );
    // The Claude Code fallback's variable stays beside it.
    expect(value(agent, "ANTHROPIC_BASE_URL")).toBe(
      `http://${PROXY_IP}:8080/anthropic`,
    );
    const deepInfra = agentStage(
      {
        ...DEVELOPER,
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
        providers: [
          {
            name: "deepinfra",
            upstream: "https://api.deepinfra.com",
            credential: "bearer",
            secretPath: MODEL_SECRET_PATH,
            api: { kind: "openai-compatible", path: "/v1/openai" },
          },
        ],
      },
      LIMITS,
      SETTINGS,
    ).clientJob(PROXY_IP);
    expect(value(deepInfra, "FOREMAN_MODEL_API")).toBe("openai-compatible");
    expect(value(deepInfra, "FOREMAN_MODEL_BASE_URL")).toBe(
      `http://${PROXY_IP}:8080/deepinfra/v1/openai`,
    );
    expect(value(deepInfra, "ANTHROPIC_BASE_URL")).toBeUndefined();
    // The proxy's provider list is unchanged: the API is the agent's setting only.
    expect(
      JSON.parse(
        value(agentStage(DEVELOPER, LIMITS, SETTINGS).proxyJob, "MODEL_PROVIDERS") ??
          "",
      ),
    ).toEqual([
      {
        name: "anthropic",
        upstream: "https://api.anthropic.com",
        credential: "x-api-key",
        secretPath: MODEL_SECRET_PATH,
      },
    ]);
  });

  it("gives the same objects for the same input", () => {
    expect(everything()).toEqual(everything());
  });

  it("makes QA's volume ReadWriteOnce, with the configured size and class", () => {
    expect(workspaceClaim(QA, SETTINGS).spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "1Gi" } },
      storageClassName: "do-block-storage",
    });
  });
});

describe("checkRunSpec (unit: refusing a run that breaks ADR 0106)", () => {
  it.each<[string, KubernetesRunSpec, RegExp]>([
    [
      "an unpinned image",
      { ...DEVELOPER, image: "claude-code:latest" },
      /pinned by digest/,
    ],
    [
      "a QA run with CONNECT hosts",
      { ...QA, allowedHosts: ["github.com"] },
      /reaches only/,
    ],
    [
      "a Council run with CONNECT hosts",
      { ...COUNCIL, allowedHosts: ["x.example.com"] },
      /reaches only/,
    ],
    ["QA without its head commit", { ...QA, headSha: undefined }, /head commit/],
    ["QA without fetch hosts", { ...QA, fetchAllowedHosts: [] }, /fetch step/],
    [
      "a fetch step outside QA",
      { ...DEVELOPER, fetchAllowedHosts: ["github.com"] },
      /only a QA run/,
    ],
    [
      "an IP address as a host",
      { ...DEVELOPER, allowedHosts: ["10.0.0.1"] },
      /plain host name/,
    ],
    ["a bad run id", { ...DEVELOPER, runId: "Run_1" }, /run id/],
    [
      "a Developer without its repository",
      { ...DEVELOPER, repository: undefined },
      /repository/,
    ],
    [
      "a reserved base URL variable",
      {
        ...DEVELOPER,
        providers: [{ ...DEVELOPER.providers[0]!, baseUrlEnv: "HTTPS_PROXY" }],
      },
      /base URL variable/,
    ],
    [
      "a Developer whose provider has no API (D-222)",
      {
        ...DEVELOPER,
        providers: [{ ...DEVELOPER.providers[0]!, api: undefined }],
      },
      /needs its provider's API/,
    ],
    [
      "an unknown provider API",
      {
        ...DEVELOPER,
        providers: [
          {
            ...DEVELOPER.providers[0]!,
            api: { kind: "bedrock" as never, path: "/v1" },
          },
        ],
      },
      /invalid API/,
    ],
    ...["", "v1", "/v1/", "/../v1", "/v1/./x", "/v1?x=1", "/v 1"].map(
      (path): [string, KubernetesRunSpec, RegExp] => [
        `an API path of ${JSON.stringify(path)}`,
        {
          ...DEVELOPER,
          providers: [{ ...DEVELOPER.providers[0]!, api: { kind: "anthropic", path } }],
        },
        /invalid API/,
      ],
    ),
    [
      "two providers that set their API",
      {
        ...DEVELOPER,
        providers: [
          DEVELOPER.providers[0]!,
          {
            name: "deepinfra",
            upstream: "https://api.deepinfra.com",
            credential: "bearer",
            secretPath: "projects/rehearsal/models/deepinfra",
            api: { kind: "openai-compatible", path: "/v1/openai" },
          },
        ],
      },
      /at most one provider/,
    ],
    [
      "an unknown service tier",
      { ...DEVELOPER, serviceTier: "batch" as never },
      /serviceTier/,
    ],
    [
      "a negative Flex capacity retry count",
      { ...DEVELOPER, flexCapacityRetries: -1 },
      /flexCapacityRetries/,
    ],
    [
      "no rejected-request ceiling",
      { ...DEVELOPER, maxRejectedModelRequests: 0 },
      /maxRejectedModelRequests/,
    ],
    [
      "a run with no price (ADR 0114 section 5)",
      { ...DEVELOPER, price: null as never },
      /price must be an object/,
    ],
    [
      "a price with no Standard price",
      {
        ...DEVELOPER,
        price: {
          tiers: ["standard", "flex"],
          pricePerMTok: { flex: { input: 1, cachedInput: 0.1, output: 2 } },
        },
        serviceTier: "flex",
      },
      /price has no Standard price/,
    ],
    [
      "a price with none for the requested, supported tier",
      {
        ...DEVELOPER,
        price: { ...DEVELOPER.price, tiers: ["standard", "flex"] },
        serviceTier: "flex",
      },
      /price has no price for the requested tier/,
    ],
    [
      "a provider named state-api",
      { ...DEVELOPER, providers: [{ ...DEVELOPER.providers[0]!, name: "state-api" }] },
      /invalid name/,
    ],
  ])("refuses %s", (_label, spec, pattern) => {
    expect(() => checkRunSpec(spec, LIMITS)).toThrow(pattern);
  });

  it("accepts each fixture", () => {
    expect(() => checkRunSpec(DEVELOPER, LIMITS)).not.toThrow();
    expect(() => checkRunSpec(QA, QA_LIMITS)).not.toThrow();
    expect(() => checkRunSpec(COUNCIL, LIMITS)).not.toThrow();
  });
});
