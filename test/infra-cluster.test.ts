import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AGENTS_POOL } from "../src/adapters/agent-runtime/kubernetes/manifests.ts";
import { PLATFORM_POOL, RECEIVER, serviceUrl } from "../infra/kubernetes/platform.ts";

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

  it("allows outbound HTTPS and DNS only, plus ports Didi approves (empty by default)", () => {
    const fixed = blocks(firewall, /\boutbound_rule/).map((rule) => {
      const a = attrs(rule);
      return `${a.protocol}/${a.port_range}`;
    });
    expect(fixed.sort()).toEqual(["tcp/443", "tcp/53", "udp/53"]);
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

  it("gives the cluster CA as the only part of the admin credential", () => {
    const ca = outputs.find(
      (o) => o.name === "cluster_ca_certificate" && /kube_config/.test(o.body),
    );
    expect(ca?.body).toMatch(/kube_config\[0\]\.cluster_ca_certificate/);
  });
});

describe("receiver tunnel (unit: D-195)", () => {
  it("routes one host name and the webhook path to the receiver's internal Service only", () => {
    const config = only(
      cfCode,
      /resource\s+"cloudflare_zero_trust_tunnel_cloudflared_config"\s+"receiver"/,
    );
    const rules = [...config.matchAll(/service\s*=\s*([^\n]+)/g)].map((m) =>
      m[1]?.trim(),
    );
    expect(rules).toEqual(["var.receiver_tunnel.service_url", '"http_status:404"']);
    expect(only(stackCode, /variable\s+"receiver_service_url"/)).toContain(
      `default     = "${serviceUrl(RECEIVER)}"`,
    );
    expect(only(stackCode, /variable\s+"receiver_webhook_path"/)).toContain(
      `default     = "^${RECEIVER.webhookPath}$"`,
    );
  });

  it("validates that the tunnel targets an in-cluster Service", () => {
    expect(only(cfCode, /variable\s+"receiver_tunnel"/)).toMatch(
      /svc\\\\.cluster\\\\.local/,
    );
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
