// Unit: the add-only rule's decisions (.github/scripts/add-only.mjs, D-378, D-436, D-444, ADR 0118
// appendix B, O-158) on fixture plans: the candidates from a settings checkout, the Platform
// lists and verdict from rendered objects and platform-diff.sh's lines, and the Infra verdict
// from a plan's addresses and actions (test/fixtures/add-only/). Each case of appendix B: a pure
// add of a standard project passes; a bigger quota, any delete, any update but the run watcher's
// namespace list, an extra object, a changed existing project, an extra record, a malformed plan
// and drift between main and the cluster each fail, with a fixed reason. The scripts around it run
// under bash with fake tools in test/admin-workflow-scripts.test.ts. Synthetic data only.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AGENT_NAMESPACE_PREFIX,
  MAX_NEW_PROJECTS,
  NotAddOnly,
  PROJECT_DOMAIN,
  PROJECT_LABEL,
  REASONS,
  SLUG,
  WATCHER,
  WATCHER_UPDATE,
  candidatesOf,
  infraVerdict,
  platformLists,
  platformVerdict,
  runCommand,
} from "../.github/scripts/add-only.mjs";
import { PLATFORM_NAMESPACE, RUN_WATCHER } from "../infra/kubernetes/platform.ts";
import {
  LABEL_PROJECT,
  agentNamespace,
} from "../src/adapters/agent-runtime/kubernetes/names.ts";
import { PROJECT_ENTRY_SLUG } from "../src/core/project-entry.ts";
import { RUN_WATCHER_ENV } from "../src/run-watcher/settings.ts";
import {
  BIGGER,
  STANDARD,
  candidatesFile,
  diffName,
  extracted,
  infraPlanAdd,
  projectFile,
  recordAddress,
  renderWith,
  resourceChange,
  routeAddress,
} from "./add-only-fixture.ts";

const NEW = "garden-notes";
const OLD = "rehearsal";
const standard = (slug: string) => ({ slug, quota: STANDARD });

/** The refusal's fixed reason, or "add-only" when it passes. */
function reasonOf(check: () => unknown): string {
  try {
    check();
    return "add-only";
  } catch (error) {
    if (error instanceof NotAddOnly) return error.message;
    throw error;
  }
}

describe("the candidates (unit: ADR 0118 appendix B, Platform step 1, D-436)", () => {
  const settings = { projectStandardQuota: STANDARD };
  const checkout = (files: Record<string, unknown>, marker = '{ "schema": 1 }') => ({
    marker,
    files: Object.entries(files).map(([name, file]) => ({
      name,
      text: typeof file === "string" ? file : JSON.stringify(file),
    })),
  });

  it("lists the files with the standard size, field by field, and the Cloudflare target, sorted", () => {
    expect(
      candidatesOf(
        settings,
        checkout({
          [`${OLD}.json`]: projectFile(OLD),
          [`${NEW}.json`]: projectFile(NEW),
          "big.json": projectFile("big", { quota: BIGGER }),
          "in-cluster.json": projectFile("in-cluster", { deployTarget: "cluster" }),
        }),
      ),
    ).toEqual({ schema: 1, candidates: [NEW, OLD] });
  });

  it("leaves out a file whose quota differs in any way, even in how a value is written", () => {
    for (const quota of [
      { ...STANDARD, cpu: "6.0" },
      { ...STANDARD, memory: "5120Mi" },
      { ...STANDARD, persistentVolumeClaims: STANDARD.persistentVolumeClaims + 1 },
      { ...STANDARD, extra: "1" },
      { pods: STANDARD.pods },
      null,
    ]) {
      expect(
        candidatesOf(settings, checkout({ "p.json": projectFile("p", { quota }) }))
          .candidates,
        JSON.stringify(quota),
      ).toEqual([]);
    }
  });

  it("leaves out a file of another schema, with a slug that is not its name, or off the slug rule", () => {
    const files = {
      "a.json": projectFile("a", { schema: 2 }),
      "b.json": projectFile("other"),
      "C.json": projectFile("C"),
      "d--e.json": projectFile("d--e"),
    };
    expect(candidatesOf(settings, checkout(files)).candidates).toEqual([]);
  });

  it("refuses, so no project is a candidate, a checkout without the marker, a file that is not JSON or not .json, and a standard size not in full", () => {
    const one = { "p.json": projectFile("p") };
    for (const [label, check] of [
      ["marker", () => candidatesOf(settings, checkout(one, '{"schema": 2}'))],
      ["not JSON", () => candidatesOf(settings, checkout({ "p.json": "{" }))],
      ["README", () => candidatesOf(settings, checkout({ "README.md": "x" }))],
      [
        "standard",
        () => candidatesOf({ projectStandardQuota: { pods: 1 } }, checkout(one)),
      ],
      ["no settings", () => candidatesOf(null, checkout(one))],
    ] as const) {
      expect(reasonOf(check), label).toBe(REASONS.candidates);
    }
  });

  it("uses the entry rule's slug pattern, the platform's own names, and the stack's zone", () => {
    expect(SLUG.source).toBe(PROJECT_ENTRY_SLUG.source);
    expect(`${AGENT_NAMESPACE_PREFIX}${NEW}`).toBe(agentNamespace(NEW));
    expect(PROJECT_LABEL).toBe(LABEL_PROJECT);
    expect(WATCHER).toEqual({
      namespace: PLATFORM_NAMESPACE,
      name: RUN_WATCHER.name,
      env: RUN_WATCHER_ENV.agentNamespaces,
    });
    expect(readFileSync("infra/stacks/factory/main.tf", "utf8")).toContain(
      `project_domain = "${PROJECT_DOMAIN}"`,
    );
  });
});

describe("the Platform lists (unit: appendix B, Platform steps 2 and 3)", () => {
  const full = renderWith([standard(OLD), standard(NEW)]);
  const ns = agentNamespace(NEW);
  const lists = (manifests: unknown = full, candidates = candidatesFile(OLD, NEW)) =>
    platformLists(manifests, candidates, [ns]);

  it("passes a pure add of a standard project: the base is the render without it and with the watcher's list as before", () => {
    const { projects, base, rest } = lists();
    expect(projects).toEqual([NEW]);
    const before = renderWith([standard(OLD)]);
    expect(base).toEqual(before);
    expect(rest.items.map(diffName)).toEqual(before.items.map(diffName));
    expect(rest.items.some((o) => o.metadata.namespace === ns)).toBe(false);
    // The new namespace is exactly the seven objects of an agent namespace.
    expect(full.items.length - base.items.length).toBe(7);
  });

  it("fails a bigger quota: the project is not a candidate", () => {
    const big = renderWith([standard(OLD), { slug: NEW, quota: BIGGER }]);
    expect(reasonOf(() => lists(big, candidatesFile(OLD)))).toBe(REASONS.notCandidate);
    // Listed as a candidate anyway, its objects still differ from the standard project's.
    expect(reasonOf(() => lists(big))).toBe(REASONS.notLikeExisting);
  });

  it("fails an extra object in the new namespace, or one that differs from the standard project's", () => {
    const extra = structuredClone(full);
    extra.items.push({
      ...structuredClone(
        full.items.find((o) => o.kind === "Role" && o.metadata.namespace === ns)!,
      ),
      metadata: { name: "extra", namespace: ns, labels: {} },
    } as never);
    expect(reasonOf(() => lists(extra))).toBe(REASONS.notLikeExisting);
    const wider = structuredClone(full);
    const role = wider.items.find(
      (o) =>
        o.kind === "Role" &&
        o.metadata.namespace === ns &&
        o.metadata.name === "run-watcher",
    ) as { rules: { verbs: string[] }[] };
    role.rules[0]!.verbs.push("delete");
    expect(reasonOf(() => lists(wider))).toBe(REASONS.notLikeExisting);
  });

  it("fails when no standard-size project is already rendered to compare with", () => {
    const alone = renderWith([standard(NEW), { slug: OLD, quota: BIGGER }]);
    expect(reasonOf(() => lists(alone, candidatesFile(NEW)))).toBe(
      REASONS.notLikeExisting,
    );
  });

  it("fails a new namespace that is not a project's, no new namespace, and more than three", () => {
    expect(
      reasonOf(() => platformLists(full, candidatesFile(OLD, NEW), ["foreman-eval"])),
    ).toBe(REASONS.notCandidate);
    expect(reasonOf(() => platformLists(full, candidatesFile(OLD, NEW), []))).toBe(
      REASONS.noProject,
    );
    const slugs = ["a1", "a2", "a3", "a4"];
    const many = renderWith([standard(OLD), ...slugs.map(standard)]);
    expect(
      reasonOf(() =>
        platformLists(many, candidatesFile(OLD, ...slugs), slugs.map(agentNamespace)),
      ),
    ).toBe(REASONS.tooMany);
    expect(MAX_NEW_PROJECTS).toBe(3);
    // Three at once pass.
    const three = renderWith([standard(OLD), ...slugs.slice(0, 3).map(standard)]);
    expect(
      platformLists(
        three,
        candidatesFile(OLD, ...slugs),
        slugs.slice(0, 3).map(agentNamespace),
      ).projects,
    ).toEqual(slugs.slice(0, 3));
  });

  it("fails when the run watcher's namespace list does not gain the new namespace once, or cannot be read", () => {
    const watcherEnv = (m: typeof full) =>
      (
        m.items.find(
          (o) => o.kind === "Deployment" && o.metadata.name === "run-watcher",
        ) as {
          spec: {
            template: {
              spec: { containers: { env: { name: string; value?: string }[] }[] };
            };
          };
        }
      ).spec.template.spec.containers[0]!.env.find(
        (e) => e.name === "AGENT_NAMESPACES",
      )!;
    const missing = structuredClone(full);
    watcherEnv(missing).value = agentNamespace(OLD);
    expect(reasonOf(() => lists(missing))).toBe(REASONS.watcherList);
    const twice = structuredClone(full);
    watcherEnv(twice).value = `${ns},${ns},${agentNamespace(OLD)}`;
    expect(reasonOf(() => lists(twice))).toBe(REASONS.watcherList);
    const unreadable = structuredClone(full);
    delete watcherEnv(unreadable).value;
    expect(reasonOf(() => lists(unreadable))).toBe(REASONS.watcher);
    const none = structuredClone(full);
    none.items = none.items.filter(
      (o) => o.metadata.name !== "run-watcher" || o.kind !== "Deployment",
    );
    expect(reasonOf(() => lists(none))).toBe(REASONS.watcher);
  });

  it("fails malformed rendered objects or candidates", () => {
    for (const manifests of [
      null,
      {},
      { kind: "List", items: [{ kind: "Namespace" }] },
    ]) {
      expect(
        reasonOf(() => lists(manifests)),
        JSON.stringify(manifests),
      ).toBe(REASONS.manifests);
    }
    for (const candidates of [
      null,
      { schema: 2, candidates: [NEW] },
      { schema: 1, candidates: [NEW, NEW] },
      { schema: 1, candidates: ["Not a slug"] },
    ]) {
      expect(
        reasonOf(() => platformLists(full, candidates, [ns])),
        JSON.stringify(candidates),
      ).toBe(REASONS.candidates);
    }
  });
});

describe("the Platform verdict (unit: appendix B, Platform steps 3 and 4)", () => {
  const ns = [agentNamespace(NEW)];

  it("passes when the base changes nothing and the rest changes only the run watcher", () => {
    expect(platformVerdict(ns, "", `${WATCHER_UPDATE}\n`)).toEqual([NEW]);
  });

  it("fails drift between main and the cluster, or a changed existing project: the base changes something", () => {
    for (const base of [
      "update apps.v1.Deployment.foreman-platform.state-api\n",
      `update v1.ResourceQuota.${agentNamespace(OLD)}.agents\n`,
      "create networking.k8s.io.v1.NetworkPolicy.foreman-platform.extra\n",
    ]) {
      expect(
        reasonOf(() => platformVerdict(ns, base, `${WATCHER_UPDATE}\n`)),
        base,
      ).toBe(REASONS.drift);
    }
  });

  it("fails any update but the run watcher's, an extra object, or no watcher change", () => {
    for (const rest of [
      `${WATCHER_UPDATE}\nupdate apps.v1.Deployment.foreman-platform.receiver\n`,
      `${WATCHER_UPDATE}\ncreate rbac.authorization.k8s.io.v1.ClusterRole..extra\n`,
      "",
      "update apps.v1.Deployment.foreman-platform.state-api\n",
    ]) {
      expect(
        reasonOf(() => platformVerdict(ns, "", rest)),
        rest,
      ).toBe(REASONS.otherChange);
    }
  });

  it("fails a diff it cannot read", () => {
    for (const rest of [
      "delete apps.v1.Deployment.foreman-platform.run-watcher\n",
      "garbage line\n",
    ]) {
      expect(
        reasonOf(() => platformVerdict(ns, "", rest)),
        rest,
      ).toBe(REASONS.diff);
    }
  });
});

describe("the Infra verdict (unit: appendix B, Infra)", () => {
  const plan = () => extracted(infraPlanAdd());
  const LINE = "Plan: 2 to add, 0 to change, 0 to destroy.";
  const verdict = (p: unknown, line = LINE, candidates = candidatesFile(OLD, NEW)) =>
    reasonOf(() => infraVerdict(p, candidates, line));
  const withChange = (change: ReturnType<typeof resourceChange>) => {
    const p = plan();
    p.resource_changes.push({
      address: change.address,
      mode: change.mode,
      type: change.type,
      actions: change.change.actions,
    });
    return p;
  };

  it("passes a pure add of a standard project's record and route", () => {
    expect(infraVerdict(plan(), candidatesFile(OLD, NEW), LINE)).toEqual([NEW]);
    // A data source's read is not a change.
    const read = withChange(
      resourceChange(
        "module.edge.data.cloudflare_zero_trust_tunnel_cloudflared_token.receiver[0]",
        ["read"],
        "data",
      ),
    );
    expect(infraVerdict(read, candidatesFile(OLD, NEW), LINE)).toEqual([NEW]);
  });

  it("fails a project that is not a candidate: a bigger quota or another target", () => {
    expect(verdict(plan(), LINE, candidatesFile(OLD))).toBe(REASONS.notCandidate);
  });

  it("fails any delete or replace", () => {
    for (const actions of [["delete"], ["delete", "create"], ["create", "delete"]]) {
      const p = withChange(resourceChange(recordAddress("old-project"), actions));
      expect(verdict(p), actions.join(",")).toBe(REASONS.delete);
    }
  });

  it("fails any update", () => {
    const p = plan();
    p.resource_changes = p.resource_changes.map((c) =>
      c.address === routeAddress(OLD) ? { ...c, actions: ["update"] } : c,
    );
    expect(verdict(p)).toBe(REASONS.update);
  });

  it("fails an extra record or any other create", () => {
    for (const address of [
      "module.edge.cloudflare_dns_record.receiver[0]",
      'module.edge.cloudflare_dns_record.project["garden-notes.example.com"]',
      'module.edge.cloudflare_dns_record.project["shop.garden-notes.didi.build"]',
      "module.cluster.digitalocean_kubernetes_node_pool.extra",
    ]) {
      expect(verdict(withChange(resourceChange(address, ["create"]))), address).toBe(
        REASONS.otherCreate,
      );
    }
    // A create typed otherwise than its address.
    const p = plan();
    p.resource_changes = p.resource_changes.map((c) =>
      c.address === recordAddress(NEW) ? { ...c, type: "cloudflare_workers_route" } : c,
    );
    expect(verdict(p)).toBe(REASONS.otherCreate);
  });

  it("fails a record without its route, or a route without its record", () => {
    for (const address of [recordAddress(NEW), routeAddress(NEW)]) {
      const p = plan();
      p.resource_changes = p.resource_changes.filter((c) => c.address !== address);
      expect(verdict(p, "Plan: 1 to add, 0 to change, 0 to destroy."), address).toBe(
        REASONS.unpaired,
      );
    }
  });

  it("fails an output change, more than three projects, no project, and a plan line that does not count two creates per project", () => {
    const outputs = plan();
    outputs.output_changes[0]!.actions = ["update"];
    expect(verdict(outputs)).toBe(REASONS.outputs);
    const many = plan();
    const slugs = ["a1", "a2", "a3"];
    for (const slug of slugs) {
      many.resource_changes.push(
        {
          address: recordAddress(slug),
          mode: "managed",
          type: "cloudflare_dns_record",
          actions: ["create"],
        },
        {
          address: routeAddress(slug),
          mode: "managed",
          type: "cloudflare_workers_route",
          actions: ["create"],
        },
      );
    }
    expect(
      verdict(
        many,
        "Plan: 8 to add, 0 to change, 0 to destroy.",
        candidatesFile(OLD, NEW, ...slugs),
      ),
    ).toBe(REASONS.tooMany);
    const none = plan();
    none.resource_changes = none.resource_changes.filter(
      (c) => c.actions[0] === "no-op",
    );
    expect(verdict(none, "")).toBe(REASONS.noProject);
    for (const line of [
      "Plan: 3 to add, 0 to change, 0 to destroy.",
      "Plan: 0 to import, 2 to add, 0 to change, 0 to destroy.",
      "",
    ]) {
      expect(verdict(plan(), line), line).toBe(REASONS.count);
    }
  });

  it("fails a malformed plan", () => {
    const dup = plan();
    dup.resource_changes.push(dup.resource_changes.at(-1)!);
    for (const p of [
      null,
      { resource_changes: [] },
      { resource_changes: [{ address: recordAddress(NEW) }], output_changes: [] },
      {
        ...plan(),
        resource_changes: [{ ...plan().resource_changes[0], mode: "other" }],
      },
      { ...plan(), output_changes: [{ name: "x" }] },
      dup,
    ]) {
      expect(verdict(p), JSON.stringify(p).slice(0, 80)).toBe(REASONS.plan);
    }
    // An action no plan has, on a managed resource, is a doubt too.
    const odd = plan();
    odd.resource_changes[0]!.actions = ["read"];
    expect(verdict(odd)).toBe(REASONS.plan);
  });
});

describe("the command line (unit)", () => {
  it("prints the projects and exits 0 only on an add-only plan, the reason and 1 otherwise, and 2 on a wrong use", () => {
    expect(
      runCommand(["infra", "/nonexistent/changes.json", "/nonexistent/c.json", "x"]),
    ).toEqual({
      line: REASONS.plan,
      status: 1,
    });
    expect(runCommand(["platform-verdict"]).status).toBe(2);
    expect(runCommand([]).status).toBe(2);
    expect(
      runCommand(["candidates", "/nonexistent/settings.json", "/nonexistent"]),
    ).toEqual({
      line: REASONS.candidates,
      status: 1,
    });
  });
});
