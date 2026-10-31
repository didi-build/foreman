import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { findInfraBoundaryViolations } from "../scripts/lib/infra-boundaries.mjs";

const at = (path: string, text: string) =>
  findInfraBoundaryViolations([{ path, text }]);

describe("infrastructure boundary (unit: IaC guard, D-146, ADR 0110)", () => {
  it("allows Cloudflare declarations inside the platform module", () => {
    expect(
      at(
        "infra/modules/platform/cloudflare/main.tf",
        'resource "cloudflare_dns_record" "x" {}',
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "a resource in a stack",
      "infra/stacks/x/main.tf",
      'resource "cloudflare_dns_record" "x" {}',
      ["a Cloudflare resource or data source"],
    ],
    [
      "a data source in the project module",
      "infra/modules/project/main.tf",
      'data "cloudflare_zone" "z" {}',
      ["a Cloudflare resource or data source"],
    ],
    [
      "a provider block in a stack",
      "infra/stacks/x/main.tf",
      'provider "cloudflare" {}',
      ["a provider block"],
    ],
    [
      "a provider block even inside its platform module",
      "infra/modules/platform/digitalocean/main.tf",
      'provider "digitalocean" {}',
      ["a provider block"],
    ],
    [
      "the provider source in a stack",
      "infra/stacks/x/versions.tf",
      'terraform {\n  required_providers {\n    cloudflare = { source = "cloudflare/cloudflare" }\n  }\n}',
      ["the Cloudflare provider source", "a required_providers block"],
    ],
    [
      "an ephemeral resource",
      "infra/stacks/x/main.tf",
      'ephemeral "cloudflare_api_token" "t" {}',
      ["a Cloudflare resource or data source"],
    ],
    [
      "a resource in another platform module",
      "infra/modules/platform/kubernetes/main.tf",
      'resource "cloudflare_r2_bucket" "b" {}',
      ["a Cloudflare resource or data source"],
    ],
    [
      "a DigitalOcean resource in a stack",
      "infra/stacks/factory/main.tf",
      'resource "digitalocean_kubernetes_cluster" "c" {}',
      ["a DigitalOcean resource or data source"],
    ],
    [
      "a DigitalOcean data source in the Cloudflare module",
      "infra/modules/platform/cloudflare/main.tf",
      'data "digitalocean_kubernetes_versions" "v" {}',
      ["a DigitalOcean resource or data source"],
    ],
    [
      "the DigitalOcean provider source in the project module",
      "infra/modules/project/versions.tf",
      'terraform {\n  required_providers {\n    digitalocean = { source = "digitalocean/digitalocean" }\n  }\n}',
      ["the DigitalOcean provider source", "a required_providers block"],
    ],
    [
      "any other provider named in a stack",
      "infra/stacks/factory/versions.tf",
      'terraform {\n  required_providers {\n    kubernetes = { source = "hashicorp/kubernetes" }\n  }\n}',
      ["a required_providers block"],
    ],
  ])("rejects %s", (_label, path, text, whats) => {
    expect(at(path, text).map((v) => v.what)).toEqual(whats);
  });

  it("allows each provider and its resources inside its own platform module", () => {
    const declare = (name: string) =>
      `terraform {\n  required_providers {\n    ${name} = { source = "${name}/${name}", version = "1.0.0" }\n  }\n}\nresource "${name}_thing" "x" {}`;
    expect(
      at("infra/modules/platform/cloudflare/versions.tf", declare("cloudflare")),
    ).toEqual([]);
    expect(
      at("infra/modules/platform/digitalocean/versions.tf", declare("digitalocean")),
    ).toEqual([]);
  });

  it("allows naming the target and mentions in comments", () => {
    const text = [
      'variable "deploy_target" { default = "cloudflare" }',
      'module "cloudflare" { source = "../platform/cloudflare" }',
      '# endpoints={s3="https://acct.r2.cloudflarestorage.com"}',
      '// resource "cloudflare_dns_record" in a comment',
    ].join("\n");
    expect(at("infra/stacks/x/main.tf", text)).toEqual([]);
  });

  it.each([
    ["a resource", '{"resource": {"cloudflare_dns_record": {"x": {}}}}'],
    ["a data source", '{"data": {"cloudflare_zone": {"z": {}}}}'],
    ["a provider block", '{"provider": {"cloudflare": {}}}'],
    [
      "a provider block in list form",
      '{"provider": [{"aws": {}}, {"cloudflare": {}}]}',
    ],
    ["a DigitalOcean resource", '{"resource": {"digitalocean_firewall": {"f": {}}}}'],
    ["a file that is not valid JSON", '{"resource": '],
  ])("rejects %s in a .tf.json stack file", (_label, text) => {
    expect(at("infra/stacks/x/main.tf.json", text)).toHaveLength(1);
  });

  it("rejects the provider source in a .tf.json stack file, and the required_providers block", () => {
    const text =
      '{"terraform": {"required_providers": {"cloudflare": {"source": "cloudflare/cloudflare"}}}}';
    expect(at("infra/stacks/x/main.tf.json", text).map((v) => v.what)).toEqual([
      "the Cloudflare provider source",
      "a required_providers block",
    ]);
  });

  it("allows naming the target in a .tf.json file, and Cloudflare in its platform module", () => {
    const text =
      '{"module": {"cloudflare": {"source": "../platform/cloudflare"}}, "variable": {"deploy_target": {"default": "cloudflare"}}}';
    expect(at("infra/stacks/x/main.tf.json", text)).toEqual([]);
    expect(
      at(
        "infra/modules/platform/cloudflare/main.tf.json",
        '{"resource": {"cloudflare_dns_record": {"x": {}}}}',
      ),
    ).toEqual([]);
  });

  it("ignores generated lock files", () => {
    expect(
      at(
        "infra/stacks/x/.terraform.lock.hcl",
        'provider "registry.opentofu.org/cloudflare/cloudflare" {}',
      ),
    ).toEqual([]);
  });
});

describe("infrastructure boundary on this repo (integration: CLI)", () => {
  it("passes on the committed infra/ tree", () => {
    const run = spawnSync(process.execPath, ["scripts/check-infra-boundaries.mjs"], {
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});
