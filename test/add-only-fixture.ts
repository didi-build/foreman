// Shared by the add-only rule's tests (D-378, ADR 0118 appendix B, O-158): renders with made-up
// platform values (test/admin-workflows-fixture.ts) and standard-size or bigger projects, the
// live cluster as the fake kubectl keeps it, project files, and fixture infrastructure plans in
// the shape `tofu show -json` prints them. Nothing here is a real value: the projects are made up,
// the zone is the stack's own `didi.build`, and the zone id is a placeholder.
import { readFileSync } from "node:fs";

import { clusterObjects, forServerSideApply } from "../infra/kubernetes/render.ts";
import type { AgentQuota } from "../src/adapters/agent-runtime/kubernetes/namespace.ts";
import { committedSettings, filledSettings } from "./admin-workflows-fixture.ts";

/** The committed standard size (D-436), read from the settings file as the check reads it. */
export const STANDARD = (committedSettings() as { projectStandardQuota: AgentQuota })
  .projectStandardQuota;

/** A size bigger than the standard by one pod: not add-only. */
export const BIGGER: AgentQuota = { ...STANDARD, pods: STANDARD.pods + 1 };

export interface FixtureProject {
  slug: string;
  quota: AgentQuota;
}

/** The rendered objects for these projects, as the render job prints them (with the address in). */
export const renderWith = (projects: FixtureProject[]) =>
  forServerSideApply(
    clusterObjects({
      ...filledSettings(),
      projects: [...projects].sort((a, b) => a.slug.localeCompare(b.slug)),
    }),
  );

type Listed = ReturnType<typeof renderWith>["items"][number];

/** The file name kubectl diff gives an object: `<group.>version.Kind.namespace.name`. */
export function diffName(o: {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
}): string {
  const [group, version] = o.apiVersion.includes("/")
    ? o.apiVersion.split("/")
    : ["", o.apiVersion];
  return `${group ? `${group}.` : ""}${version}.${o.kind}.${o.metadata.namespace ?? ""}.${o.metadata.name}`;
}

/** The fake kubectl's state for a cluster that holds exactly these objects. */
export function clusterHolding(objects: readonly Listed[]) {
  return {
    namespaces: objects
      .filter((o) => o.kind === "Namespace")
      .map((o) => o.metadata.name),
    live: Object.fromEntries(objects.map((o) => [diffName(o), o])),
  };
}

/** A project file as the settings repository holds it (ADR 0118 appendix A). */
export function projectFile(
  slug: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 1,
    slug,
    displayName: slug,
    purpose: "A made-up project for the add-only rule's tests.",
    collectsPersonalData: true,
    quota: STANDARD,
    deployTarget: "cloudflare",
    createdOn: "2026-11-20",
    ...extra,
  };
}

/** The candidates file the render job keeps beside the rendered objects. */
export const candidatesFile = (...slugs: string[]) => ({
  schema: 1,
  candidates: [...slugs].sort(),
});

/** One resource change as `tofu show -json` prints it, with a made-up zone id. */
export function resourceChange(
  address: string,
  actions: string[],
  mode: "managed" | "data" = "managed",
) {
  const type =
    /\.(cloudflare_[a-z_]+|digitalocean_[a-z_]+)\./.exec(address)?.[1] ?? "other";
  return {
    address,
    mode,
    type,
    name: "project",
    provider_name: "registry.opentofu.org/cloudflare/cloudflare",
    change: {
      actions,
      before: actions.includes("create") && !actions.includes("delete") ? null : {},
      after: actions.includes("delete") && !actions.includes("create") ? null : {},
    },
  };
}

export const recordAddress = (slug: string) =>
  `module.edge.cloudflare_dns_record.project["${slug}.didi.build"]`;
export const routeAddress = (slug: string) =>
  `module.edge.cloudflare_workers_route.project["${slug}.didi.build"]`;

/** The fixture plan that only adds `garden-notes` next to the rehearsal (test/fixtures/add-only/). */
export const infraPlanAdd = () =>
  JSON.parse(readFileSync("test/fixtures/add-only/infra-plan-add.json", "utf8")) as {
    resource_changes: ReturnType<typeof resourceChange>[];
    output_changes: Record<string, { actions: string[] }>;
  };

/** What infra-add-only.sh's jq filter keeps of a plan: addresses, modes, types and actions. */
export const extracted = (plan: ReturnType<typeof infraPlanAdd>) => ({
  resource_changes: plan.resource_changes.map((c) => ({
    address: c.address,
    mode: c.mode,
    type: c.type,
    actions: c.change.actions,
  })),
  output_changes: Object.entries(plan.output_changes).map(([name, o]) => ({
    name,
    actions: o.actions,
  })),
});
