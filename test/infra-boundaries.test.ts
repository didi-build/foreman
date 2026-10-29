import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { findInfraBoundaryViolations } from "../scripts/lib/infra-boundaries.mjs";

const at = (path: string, text: string) =>
  findInfraBoundaryViolations([{ path, text }]);

describe("infrastructure boundary (unit: IaC guard, D-146)", () => {
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
    ],
    [
      "a data source in the project module",
      "infra/modules/project/main.tf",
      'data "cloudflare_zone" "z" {}',
    ],
    [
      "a provider block in a stack",
      "infra/stacks/x/main.tf",
      'provider "cloudflare" {}',
    ],
    [
      "the provider source in a stack",
      "infra/stacks/x/versions.tf",
      'terraform {\n  required_providers {\n    cloudflare = { source = "cloudflare/cloudflare" }\n  }\n}',
    ],
    [
      "an ephemeral resource",
      "infra/stacks/x/main.tf",
      'ephemeral "cloudflare_api_token" "t" {}',
    ],
    [
      "a resource in another platform module",
      "infra/modules/platform/kubernetes/main.tf",
      'resource "cloudflare_r2_bucket" "b" {}',
    ],
  ])("rejects %s", (_label, path, text) => {
    expect(at(path, text)).toHaveLength(1);
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
    [
      "the provider source",
      '{"terraform": {"required_providers": {"cloudflare": {"source": "cloudflare/cloudflare"}}}}',
    ],
    ["a file that is not valid JSON", '{"resource": '],
  ])("rejects %s in a .tf.json stack file", (_label, text) => {
    expect(at("infra/stacks/x/main.tf.json", text)).toHaveLength(1);
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
