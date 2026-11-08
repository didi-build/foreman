import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { AGENTS_POOL } from "../src/adapters/agent-runtime/kubernetes/manifests.ts";
import {
  DEFAULT_DATABASE_PORT,
  PLATFORM_POOL,
  RECEIVER,
  STATE_API_PUBLIC,
  TUNNEL_EDGE_PORT,
  serviceUrl,
} from "../infra/kubernetes/platform.ts";
import {
  PLATFORM_SETTINGS,
  PROJECT_SLUG,
  projectStagingUrl,
} from "../src/core/register-project.ts";
import { committedSettings } from "./admin-workflows-fixture.ts";

// Unit: static checks on the cluster's infrastructure code (ADR 0106, ADR 0110, D-188, D-193 to
// D-195). OpenTofu is not run here; these read the .tf files as text, so they hold without
// credentials, a backend or a provider download.

const DO_MODULE = "infra/modules/platform/digitalocean";
const CF_MODULE = "infra/modules/platform/cloudflare";
const STACK = "infra/stacks/factory";

function listTf(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === ".terraform" ? [] : listTf(path);
    return entry.name.endsWith(".tf") ? [path] : [];
  });
}

/** HCL with whole-line and trailing comments removed. URLs inside strings are kept. */
const code = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*(#|\/\/).*$/gm, "")
    .replace(/\s+#\s.*$/gm, "");

const read = (dir: string): string =>
  listTf(dir)
    .map((path) => code(readFileSync(path, "utf8")))
    .join("\n");

/** The bodies of every block whose header matches, braces balanced. */
function blocks(text: string, header: RegExp): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`${header.source}\\s*\\{`, "g");
  for (const match of text.matchAll(pattern)) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    const start = i;
    while (depth > 0 && i < text.length) {
      if (text[i] === "{") depth++;
      if (text[i] === "}") depth--;
      i++;
    }
    found.push(text.slice(start, i - 1));
  }
  return found;
}

function only(text: string, header: RegExp): string {
  const found = blocks(text, header);
  expect(found, `exactly one block matching ${header}`).toHaveLength(1);
  return found[0] ?? "";
}

/** `key = "value"` pairs at any depth of a block body. */
const attrs = (body: string): Record<string, string> =>
  Object.fromEntries(
    [...body.matchAll(/"?([\w/.-]+)"?\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );

const doCode = read(DO_MODULE);
const cfCode = read(CF_MODULE);
const stackCode = read(STACK);
const allInfra = read("infra");

describe("DigitalOcean cluster module (unit: ADR 0106 section 1, D-193, D-194)", () => {
  const cluster = only(doCode, /resource\s+"digitalocean_kubernetes_cluster"\s+"this"/);

  it("declares the provider with an exact version", () => {
    const versions = only(doCode, /digitalocean\s*=/);
    expect(versions).toMatch(/source\s*=\s*"digitalocean\/digitalocean"/);
    expect(versions).toMatch(/version\s*=\s*"\d+\.\d+\.\d+"/);
  });

  it("is one cluster in tor1 with the standard control plane", () => {
    expect(
      blocks(doCode, /resource\s+"digitalocean_kubernetes_cluster"\s+"\w+"/),
    ).toHaveLength(1);
    expect(only(doCode, /variable\s+"region"/)).toMatch(/default\s*=\s*"tor1"/);
    expect(stackCode).toMatch(/region\s*=\s*"tor1"/);
    expect(cluster).toMatch(/\bha\s*=\s*false/);
    expect(cluster).toMatch(/auto_upgrade\s*=\s*var\.auto_upgrade/);
    expect(only(cluster, /maintenance_policy/)).toMatch(
      /day\s*=\s*var\.maintenance_day/,
    );
  });

  it("has a platform pool and an agents pool, one 2 vCPU / 4 GB node each", () => {
    expect(only(doCode, /variable\s+"node_size"/)).toMatch(
      /default\s*=\s*"s-2vcpu-4gb"/,
    );
    const platform = only(cluster, /node_pool/);
    expect(platform).toMatch(/name\s*=\s*"platform"/);
    const agents = only(
      doCode,
      /resource\s+"digitalocean_kubernetes_node_pool"\s+"agents"/,
    );
    expect(agents).toMatch(/name\s*=\s*"agents"/);
    expect(
      blocks(doCode, /resource\s+"digitalocean_kubernetes_node_pool"\s+"\w+"/),
    ).toHaveLength(1);
    expect(stackCode).toMatch(/platform_node_count\s*=\s*1\b/);
    expect(stackCode).toMatch(/agents_node_count\s*=\s*1\b/);
  });

  it("labels and taints the agents pool exactly as the runtime adapter's pods expect", () => {
    const agents = only(
      doCode,
      /resource\s+"digitalocean_kubernetes_node_pool"\s+"agents"/,
    );
    expect(attrs(only(agents, /labels\s*=/))).toEqual({
      [AGENTS_POOL.key]: AGENTS_POOL.value,
    });
    expect(attrs(only(agents, /taint/))).toEqual({
      key: AGENTS_POOL.key,
      value: AGENTS_POOL.value,
      effect: "NoSchedule",
    });
  });

  it("labels the platform pool as the platform manifests select, with no taint", () => {
    const platform = only(cluster, /node_pool/);
    expect(attrs(only(platform, /labels\s*=/))).toEqual({
      [PLATFORM_POOL.key]: PLATFORM_POOL.value,
    });
    expect(blocks(platform, /taint/)).toEqual([]);
  });

  it("limits the API endpoint to listed addresses when given (D-189)", () => {
    const firewall = only(cluster, /control_plane_firewall/);
    expect(firewall).toMatch(/allowed_addresses\s*=\s*var\.api_allowed_addresses/);
    expect(firewall).toMatch(
      /enabled\s*=\s*length\(var\.api_allowed_addresses\)\s*>\s*0/,
    );
  });

  it("keeps the provider's stored admin credential short-lived", () => {
    expect(cluster).toMatch(
      /kubeconfig_expire_seconds\s*=\s*var\.kubeconfig_expire_seconds/,
    );
    const lifetime = only(doCode, /variable\s+"kubeconfig_expire_seconds"/);
    expect(Number(/default\s*=\s*(\d+)/.exec(lifetime)?.[1])).toBeLessThanOrEqual(3600);
  });
});

describe("cloud firewall (unit: ADR 0106 section 1, D-195)", () => {
  const firewall = only(doCode, /resource\s+"digitalocean_firewall"\s+"workers"/);

  it("covers the cluster's worker nodes", () => {
    expect(firewall).toMatch(
      /tags\s*=\s*\["k8s:\$\{digitalocean_kubernetes_cluster\.this\.id\}"\]/,
    );
  });

  it("has no inbound rule anywhere in infra/, so nothing public is open", () => {
    expect(allInfra).not.toMatch(/inbound_rule/);
    expect(allInfra).not.toMatch(/source_addresses/);
  });

  it("allows outbound HTTPS, DNS, the database pooler and the tunnel edge only, plus ports Didi approves", () => {
    const fixed = blocks(firewall, /\boutbound_rule/).map((rule) => {
      const a = attrs(rule);
      return `${a.protocol}/${a.port_range}`;
    });
    expect(fixed.sort()).toEqual([
      "tcp/443",
      "tcp/53",
      `tcp/${DEFAULT_DATABASE_PORT}`,
      `tcp/${TUNNEL_EDGE_PORT}`,
      "udp/53",
      `udp/${TUNNEL_EDGE_PORT}`,
    ]);
    const dynamic = only(firewall, /dynamic\s+"outbound_rule"/);
    expect(dynamic).toMatch(/for_each\s*=\s*toset\(var\.extra_outbound_tcp_ports\)/);
    expect(only(doCode, /variable\s+"extra_outbound_tcp_ports"/)).toMatch(
      /default\s*=\s*\[\]/,
    );
    expect(only(stackCode, /variable\s+"extra_outbound_tcp_ports"/)).toMatch(
      /default\s*=\s*\[\]/,
    );
  });
});

describe("outputs (unit: D-188, D-195)", () => {
  const outputs = listTf("infra").flatMap((path) => {
    const text = code(readFileSync(path, "utf8"));
    return [...text.matchAll(/output\s+"([\w-]+)"\s*\{/g)].map((m) => {
      const name = m[1] ?? "";
      return { name, body: only(text, new RegExp(`output\\s+"${name}"`)) };
    });
  });
  const CREDENTIAL =
    /kube_?config|raw_config|client_key|client_certificate|token|password|secret/i;

  it("found the outputs to check", () => {
    expect(outputs.map((o) => o.name)).toEqual(
      expect.arrayContaining(["cluster_id", "endpoint", "cluster_ca_certificate"]),
    );
  });

  it("never exposes a kubeconfig, key or token, except the sensitive tunnel token", () => {
    for (const { name, body } of outputs) {
      const value = /value\s*=\s*(.*)/.exec(body)?.[1] ?? "";
      const withoutCa = value.replace(/kube_config\[0\]\.cluster_ca_certificate/, "");
      if (name === "receiver_tunnel_token") {
        expect(body, name).toMatch(/sensitive\s*=\s*true/);
        continue;
      }
      expect(name, name).not.toMatch(CREDENTIAL);
      expect(withoutCa, name).not.toMatch(CREDENTIAL);
    }
  });

  it("marks the factory stack's API address sensitive, so its public plan and apply never show it (D-349)", () => {
    const endpoint = only(stackCode, /output\s+"cluster_endpoint"/);
    expect(endpoint).toMatch(/value\s*=\s*module\.cluster\.endpoint\b/);
    expect(endpoint).toMatch(/sensitive\s*=\s*true/);
  });

  it("gives the cluster CA as the only part of the admin credential", () => {
    const ca = outputs.find(
      (o) => o.name === "cluster_ca_certificate" && /kube_config/.test(o.body),
    );
    expect(ca?.body).toMatch(/kube_config\[0\]\.cluster_ca_certificate/);
  });
});

describe("receiver tunnel (unit: D-195)", () => {
  it("routes one host name and the webhook path to the receiver's internal Service, and the planning path only when set", () => {
    const config = only(
      cfCode,
      /resource\s+"cloudflare_zero_trust_tunnel_cloudflared_config"\s+"receiver"/,
    );
    const rules = [...config.matchAll(/service\s*=\s*([^\n]+)/g)].map((m) =>
      m[1]?.trim(),
    );
    expect(rules).toEqual([
      "var.receiver_tunnel.service_url",
      "var.planning_service_url",
      '"http_status:404"',
    ]);
    expect(only(stackCode, /variable\s+"receiver_service_url"/)).toContain(
      `default     = "${serviceUrl(RECEIVER)}"`,
    );
    expect(only(stackCode, /variable\s+"receiver_webhook_path"/)).toContain(
      `default     = "^${RECEIVER.webhookPath}$"`,
    );
  });

  it("forwards only the webhook path under /api to the receiver, not the old path or a near miss (D-343)", () => {
    const declared = /default\s*=\s*"([^"]+)"/.exec(
      only(stackCode, /variable\s+"receiver_webhook_path"/),
    )?.[1];
    expect(declared).toBe("^/api/github/webhook$");
    const webhookPath = new RegExp(declared ?? "");
    expect(webhookPath.test("/api/github/webhook")).toBe(true);
    for (const path of [
      "/github/webhook",
      "/api/github/webhook/",
      "/api/github/webhook/extra",
      "/api/github",
      "/API/github/webhook",
      "/api/GitHub/webhook",
      "/api/api/github/webhook",
      "/x/api/github/webhook",
      "/api/plans",
      "/",
    ]) {
      expect(webhookPath.test(path), path).toBe(false);
    }
  });

  it("validates that the tunnel targets an in-cluster Service", () => {
    expect(only(cfCode, /variable\s+"receiver_tunnel"/)).toMatch(
      /svc\\\\.cluster\\\\.local/,
    );
    expect(only(cfCode, /variable\s+"planning_service_url"/)).toMatch(
      /svc\\\\.cluster\\\\.local/,
    );
  });

  it("forwards exactly the planning chat's paths to the state API's public Service, on the receiver's host name, only after Didi's tunnel gate (D-271, D-282)", () => {
    const config = only(
      cfCode,
      /resource\s+"cloudflare_zero_trust_tunnel_cloudflared_config"\s+"receiver"/,
    );
    // The path is fixed in the module, not a setting, so no variable can widen it.
    const paths = [...config.matchAll(/path\s*=\s*([^\n]+)/g)].map((m) => m[1]?.trim());
    expect(paths).toEqual([
      "var.receiver_tunnel.path",
      `"${STATE_API_PUBLIC.tunnelPath}"`,
      "null",
    ]);
    expect(config).toMatch(/var\.planning_service_url == null \? \[\] :/);
    expect(only(cfCode, /variable\s+"planning_service_url"/)).toMatch(
      /default\s*=\s*null/,
    );
    expect(stackCode).toMatch(
      /planning_service_url\s*=\s*var\.expose_planning_route \? var\.planning_service_url : null/,
    );
    expect(only(stackCode, /variable\s+"expose_planning_route"/)).toMatch(
      /default\s*=\s*false/,
    );
    expect(only(stackCode, /variable\s+"planning_service_url"/)).toContain(
      `default     = "${serviceUrl(STATE_API_PUBLIC)}"`,
    );
    // No new DNS record: the path rides on the receiver's host name. The module's other records
    // are the scratch stack's TXT records and each project's staging name (D-357).
    expect(
      [...cfCode.matchAll(/resource\s+"cloudflare_dns_record"\s+"(\w+)"/g)]
        .map((m) => m[1])
        .sort(),
    ).toEqual(["project", "receiver", "txt"]);
  });

  it("matches the planning chat's four paths under /api and nothing else (D-282, D-343)", () => {
    expect(STATE_API_PUBLIC.tunnelPath).toBe(
      "^/api/(plans|planning/projects/[a-z0-9][a-z0-9-]{0,99}/(submissions|feedback|accepted))$",
    );
    const tunnelPath = new RegExp(STATE_API_PUBLIC.tunnelPath);
    for (const path of [
      "/api/plans",
      "/api/planning/projects/rehearsal/submissions",
      "/api/planning/projects/rehearsal/feedback",
      "/api/planning/projects/a-1/accepted",
      `/api/planning/projects/${"a".repeat(100)}/submissions`,
    ]) {
      expect(tunnelPath.test(path), path).toBe(true);
    }
    for (const path of [
      // The old paths, without the prefix.
      "/plans",
      "/planning/projects/rehearsal/submissions",
      "/planning/projects/rehearsal/feedback",
      "/planning/projects/a-1/accepted",
      // Near misses.
      "/",
      "/api",
      "/api/",
      "/health",
      "/api/health",
      "/api/ideas",
      "/api/decisions",
      "/api/attention",
      "/api/github/webhook",
      "/api/plans/",
      "/api/plans/extra",
      "/api/xplans",
      "/api//plans",
      "/api/api/plans",
      "/API/plans",
      "/apiplans",
      "/x/api/plans",
      "/api/planning/projects/rehearsal",
      "/api/planning/projects/rehearsal/",
      "/api/planning/projects/rehearsal/runs",
      "/api/planning/projects/rehearsal/submissions/",
      "/api/planning/projects/rehearsal/submissions/extra",
      "/api/planning/projects/Rehearsal/submissions",
      "/api/planning/projects/rehearsal/Submissions",
      "/api/planning/projects/-x/submissions",
      "/api/planning/projects/a/b/submissions",
      "/api/planning/projects/../submissions",
      `/api/planning/projects/${"a".repeat(101)}/submissions`,
    ]) {
      expect(tunnelPath.test(path), path).toBe(false);
    }
  });

  it("publishes the host name as a proxied CNAME to the tunnel", () => {
    const record = only(cfCode, /resource\s+"cloudflare_dns_record"\s+"receiver"/);
    expect(record).toMatch(/type\s*=\s*"CNAME"/);
    expect(record).toMatch(/proxied\s*=\s*true/);
    expect(record).toMatch(/cfargotunnel\.com/);
  });

  it("creates the DNS record only once Didi approves it (a separate DNS gate)", () => {
    const record = only(cfCode, /resource\s+"cloudflare_dns_record"\s+"receiver"/);
    expect(record).toMatch(/count\s*=.*var\.receiver_tunnel\.publish_dns \? 1 : 0/);
    expect(only(stackCode, /variable\s+"publish_receiver_dns"/)).toMatch(
      /default\s*=\s*false/,
    );
  });
});

describe("factory stack (unit: ADR 0110)", () => {
  it("keeps its own state key and enforces state and plan encryption", () => {
    expect(stackCode).toMatch(/key\s*=\s*"factory\/[a-z]+\.tfstate"/);
    expect(only(stackCode, /\bstate/)).toMatch(/enforced\s*=\s*true/);
    expect(only(stackCode, /\bplan/)).toMatch(/enforced\s*=\s*true/);
    expect(only(stackCode, /variable\s+"state_encryption_passphrase"/)).toMatch(
      /ephemeral\s*=\s*true/,
    );
  });

  it("wires the platform modules with variables, naming no provider", () => {
    expect(stackCode).not.toMatch(/required_providers|^\s*provider\s+"/m);
    expect(stackCode).toMatch(
      /source\s*=\s*"\.\.\/\.\.\/modules\/platform\/digitalocean"/,
    );
    expect(stackCode).toMatch(
      /source\s*=\s*"\.\.\/\.\.\/modules\/platform\/cloudflare"/,
    );
  });
});

/** An HCL quoted template such as `"${each.key}/*"`, filled in from the values given by name. */
function fill(template: string, values: Record<string, string>): string {
  const body = /^"([^"]*)"$/.exec(template.trim())?.[1];
  if (body === undefined) throw new Error(`not a quoted template: ${template}`);
  return body.replace(/\$\{([\w.]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`no value for ${name} in ${template}`);
    return value;
  });
}

/** The value of an HCL quoted string as OpenTofu reads it: `\\` is one backslash. */
const hclString = (literal: string): string => literal.replace(/\\\\/g, "\\");

describe("each project's staging name and Workers route (unit: D-345, D-357, O-112)", () => {
  // The receiver's host name, RECEIVER_HOSTNAME in the infra environments (D-343, runbook step 3).
  const RECEIVER_HOST = "foreman.didi.build";
  const stackLocals = only(stackCode, /\blocals/);
  const edge = only(stackCode, /module\s+"edge"/);
  const variable = only(cfCode, /variable\s+"project_staging"/);
  const moduleLocals = only(cfCode, /\blocals/);
  const record = only(cfCode, /resource\s+"cloudflare_dns_record"\s+"project"/);
  const route = only(cfCode, /resource\s+"cloudflare_workers_route"\s+"project"/);

  const domain = /project_domain\s*=\s*"([^"]+)"/.exec(stackLocals)?.[1] ?? "";

  // The module's map of host names: `for <slug> in <slugs> : <key> => <slug> if <key> != <receiver>`.
  const hosts =
    /project_hosts\s*=\s*\{\s*for\s+(\w+)\s+in\s+try\(var\.project_staging\.slugs, \[\]\)\s*:\s*("[^"]*")\s*=>\s*(\w+)\s+if\s+("[^"]*")\s*!=\s*local\.receiver_hostname\s*\}/.exec(
      moduleLocals,
    );
  const [, each = "", keyTemplate = "", value = "", kept = ""] = hosts ?? [];

  /** What the module makes for these slugs, read from its own expressions. */
  function planned(slugs: string[], receiver: string | null) {
    const projectHosts = slugs
      .map((slug) => ({
        slug,
        host: fill(keyTemplate, { [each]: slug, "var.project_staging.domain": domain }),
        kept: fill(kept, { [each]: slug, "var.project_staging.domain": domain }),
      }))
      .filter((p) => p.kept !== receiver);
    const pattern = /pattern\s*=\s*("[^"]*")/.exec(route)?.[1] ?? "";
    const script = /script\s*=\s*("[^"]*")/.exec(route)?.[1] ?? "";
    return {
      records: projectHosts.map((p) => p.host),
      routes: projectHosts.map((p) => ({
        pattern: fill(pattern, { "each.key": p.host }),
        script: fill(script, { "each.value": p.slug }),
      })),
    };
  }

  it("reads the project list from the platform settings file, the one list the form reads too (D-345)", () => {
    const path =
      /settings\s*=\s*jsondecode\(file\("\$\{path\.module\}\/([^"]+)"\)\)/.exec(
        stackLocals,
      )?.[1];
    expect(path).toBeDefined();
    expect(resolve(STACK, path ?? "")).toBe(resolve(PLATFORM_SETTINGS.path));
    expect(stackLocals).toMatch(
      /project_slugs\s*=\s*\[for project in local\.settings\.projects : project\.slug\]/,
    );
    expect(edge).toMatch(
      /project_staging\s*=\s*\{\s*domain\s*=\s*local\.project_domain\s+slugs\s*=\s*local\.project_slugs\s*\}/,
    );
    // The receiver's host name the module compares with is the one the stack gives the tunnel.
    expect(edge).toMatch(/hostname\s*=\s*var\.receiver_hostname/);
  });

  it("names each project <slug>.didi.build, the staging address the store records (D-345)", () => {
    expect(domain).toBe("didi.build");
    expect(projectStagingUrl("rehearsal")).toBe(`https://rehearsal.${domain}`);
    const dnsName = /can\(regex\("([^"]+)", var\.project_staging\.domain\)\)/.exec(
      variable,
    )?.[1];
    expect(dnsName).toBeDefined();
    const rule = new RegExp(hclString(dnsName ?? ""));
    expect(rule.test(domain)).toBe(true);
    for (const bad of [
      "",
      "didi",
      "didi.build.",
      "*.didi.build",
      "Didi.build",
      "didi..build",
    ]) {
      expect(rule.test(bad), bad).toBe(false);
    }
  });

  it("makes one proxied record and one Workers route per project, with the exact name, pattern and Worker", () => {
    expect(hosts, "the project_hosts expression").not.toBeNull();
    expect(value).toBe(each);
    expect(record).toMatch(/for_each\s*=\s*local\.project_hosts\b/);
    expect(record).toMatch(/zone_id\s*=\s*var\.settings\["zone_id"\]/);
    expect(record).toMatch(/name\s*=\s*each\.key\b/);
    expect(record).toMatch(/proxied\s*=\s*true\b/);
    // The originless placeholder Cloudflare documents for a proxied record (O-112).
    expect(attrs(record)).toMatchObject({ type: "AAAA", content: "100::" });
    expect(route).toMatch(/for_each\s*=\s*local\.project_hosts\b/);
    expect(route).toMatch(/zone_id\s*=\s*var\.settings\["zone_id"\]/);
    expect(route).toMatch(/depends_on\s*=\s*\[cloudflare_dns_record\.project\]/);
    expect(
      blocks(allInfra, /resource\s+"cloudflare_workers_route"\s+"\w+"/),
    ).toHaveLength(1);

    expect(planned(["rehearsal", "shop-2"], RECEIVER_HOST)).toEqual({
      records: ["rehearsal.didi.build", "shop-2.didi.build"],
      routes: [
        { pattern: "rehearsal.didi.build/*", script: "rehearsal-staging" },
        { pattern: "shop-2.didi.build/*", script: "shop-2-staging" },
      ],
    });
    expect(planned([], RECEIVER_HOST)).toEqual({ records: [], routes: [] });
  });

  it("skips a project whose host name is the receiver's, so foreman.didi.build gets no second record and no route (D-343)", () => {
    expect(kept, "the kept host is the record's own name").toBe(keyTemplate);
    expect(moduleLocals).toMatch(
      /receiver_hostname\s*=\s*var\.receiver_tunnel == null \? null : lower\(var\.receiver_tunnel\.hostname\)/,
    );
    expect(planned(["foreman", "rehearsal"], RECEIVER_HOST)).toEqual({
      records: ["rehearsal.didi.build"],
      routes: [{ pattern: "rehearsal.didi.build/*", script: "rehearsal-staging" }],
    });
    expect(planned(["foreman"], RECEIVER_HOST)).toEqual({ records: [], routes: [] });
  });

  it("refuses a slug outside the project-slug rule, and a slug listed twice", () => {
    const pattern =
      /condition\s*=\s*alltrue\(\[for slug in try\(var\.project_staging\.slugs, \[\]\) : can\(regex\("([^"]+)", slug\)\)\]\)/.exec(
        variable,
      )?.[1];
    expect(pattern).toBe(PROJECT_SLUG.source);
    const rule = new RegExp(hclString(pattern ?? ""));
    for (const good of ["rehearsal", "shop-2", "a", "0x", "a".repeat(100)]) {
      expect(rule.test(good), good).toBe(true);
    }
    for (const bad of [
      "",
      "Rehearsal",
      "-x",
      "a_b",
      "a.b",
      "a/b",
      "*",
      "a*",
      "a b",
      "a\n",
      "é",
      "rehearsal.didi.build",
      "a".repeat(101),
    ]) {
      expect(rule.test(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(variable).toMatch(
      /condition\s*=\s*length\(distinct\(try\(var\.project_staging\.slugs, \[\]\)\)\) == length\(try\(var\.project_staging\.slugs, \[\]\)\)/,
    );
  });

  it("holds every slug in the committed settings file to those rules, so a bad one fails CI before any plan", () => {
    const settings = committedSettings() as { projects: { slug: unknown }[] };
    const slugs = settings.projects.map((p) => p.slug);
    for (const slug of slugs) {
      expect(typeof slug === "string" && PROJECT_SLUG.test(slug), String(slug)).toBe(
        true,
      );
    }
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("asks for a Cloudflare token that can edit what the stack makes: tunnels, DNS records and Workers routes (D-357, runbook step 3)", () => {
    const runbook = readFileSync("docs/runbooks/first-hosting.md", "utf8");
    const token = runbook
      .split("\n")
      .find((line) => line.startsWith("- A Cloudflare API token"));
    for (const permission of [
      "Cloudflare Tunnel: Edit",
      "DNS: Edit",
      "Workers Routes: Edit",
    ]) {
      expect(token, permission).toContain(permission);
    }
    for (const type of [
      "cloudflare_zero_trust_tunnel_cloudflared",
      "cloudflare_dns_record",
      "cloudflare_workers_route",
    ]) {
      expect(cfCode).toMatch(new RegExp(`resource\\s+"${type}"`));
    }
  });
});
