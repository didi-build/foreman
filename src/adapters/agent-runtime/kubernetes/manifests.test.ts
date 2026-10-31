import { describe, expect, it } from "vitest";

import { secretEnvName } from "../../../service-kit/config.ts";
import {
  COUNCIL,
  DEVELOPER,
  GITHUB_TOKEN,
  LIMITS,
  MODEL_KEY,
  MODEL_SECRET_PATH,
  QA,
  QA_LIMITS,
  SETTINGS,
  STATE_TOKEN,
  credentialsFor,
  taskFor,
} from "./fixtures.ts";
import {
  AGENTS_POOL,
  agentStage,
  checkRunSpec,
  fetchStage,
  runSecrets,
  taskSecret,
  workspaceClaim,
  type KubernetesRunSpec,
} from "./manifests.ts";
import { LABEL_RUN_ID, runNames } from "./names.ts";
import type { EnvVar, Job, NetworkPolicy, RunObject } from "./objects.ts";

// Unit: the run's manifests as pure functions (ADR 0106 sections 2 to 6). No cluster.

const PROXY_IP = "10.245.0.10";

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
  const stages = [dev, council, qa, fetch];
  const jobs = stages.flatMap((s) => [s.proxyJob, s.clientJob(PROXY_IP)]);
  const objects: RunObject[] = [
    ...jobs,
    ...stages.flatMap((s) => [...s.policies, s.proxyService]),
    ...runSecrets(DEVELOPER, credentialsFor(DEVELOPER)),
    ...runSecrets(QA, credentialsFor(QA)),
    ...runSecrets(COUNCIL, credentialsFor(COUNCIL)),
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
      "github.com,codeload.github.com",
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
