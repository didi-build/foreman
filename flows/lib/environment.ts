// What a flow reads from its host (build plan M3.1, ADR 0111 section 4). Secrets are asked for by
// path, never by a variable of their own: Windmill secret variables now (D-370), Vault later.
// Plain values are settings that are not secret, such as the cluster address, Windmill plain
// variables. The Windmill binding is in ./windmill.ts; tests pass a fake.

export interface FlowEnvironment {
  /** The secret at `path`. Never logged, never returned in a flow result. */
  secret(path: string): Promise<string>;
  /** A plain, non-secret value by name. */
  value(name: string): Promise<string>;
  /** This month's Windmill executions, read from Windmill's API (D-167). */
  executionsThisMonth(): Promise<number>;
}

/**
 * Every fixed secret path the flows read. `flows/windmill.yaml` lists the same paths. A run's
 * model key is read too, at the path its bot file's provider names for the run's project (D-143).
 */
export const SECRET_PATHS = {
  /** A login user in the `factory_runner` role (ADR 0104). New at first hosting. */
  database: "platform/state-store/runner-database-url",
  /** The runner's cluster token (ADR 0106 section 1, first-hosting runbook step 8). */
  clusterToken: "platform/agent-cluster/runner-token",
  /**
   * The staging deploy token: one Cloudflare API token with Workers Scripts: Edit on the account
   * only (D-353, O-116, first-hosting runbook step 16). Didi creates it; new at first hosting.
   */
  stagingDeployToken: "platform/cloudflare/staging-deploy-token",
  /**
   * The Cloudflare account the staging Workers live in, 32 hex characters: an id, kept as a
   * secret as D-361 keeps it in GitHub, never logged (O-116, runbook step 16).
   */
  cloudflareAccountId: "platform/cloudflare/account-id",
  /**
   * The four GitHub Apps' private keys, each the PEM GitHub generated (D-368, D-370, runbook step
   * 15). Each is read only when its App's first token of the flow is minted (O-125).
   */
  runnerAppPrivateKey: "platform/github/runner-app-private-key",
  developerAppPrivateKey: "platform/github/developer-app-private-key",
  designerAppPrivateKey: "platform/github/designer-app-private-key",
  qaAppPrivateKey: "platform/github/qa-app-private-key",
} as const;

/** Every plain value the flows read. `flows/windmill.yaml` lists the same names. */
export const VALUE_NAMES = {
  /** The git commit of docs/spec.md and contracts/ the bundle was built from. */
  specVersion: "spec_version",
  developerAppLogin: "github_developer_app_login",
  designerAppLogin: "github_designer_app_login",
  runnerAppSlug: "github_runner_app_slug",
  clusterEndpoint: "agent_cluster_endpoint",
  clusterCaCertificate: "agent_cluster_ca_certificate",
  /** The Kubernetes run settings as JSON (ADR 0106), no secret in it. */
  agentRunSettings: "agent_run_settings",
  /**
   * The agent image references by image kind as JSON, each pinned by digest, for example
   * `{"opencode": "<registry>/opencode@sha256:...", "claude-api": "..."}`. Each role's bot file
   * names its kind (contracts/bots/); the digest changes with each image build, so it is a value.
   */
  agentImages: "agent_images",
  /**
   * Each GitHub App's id and the runner App's installation id on `didi-build`, decimal numbers,
   * plain variables beside the keys (D-368, D-370, O-120). Read with the key, on its App's first
   * token (O-125).
   */
  runnerAppId: "platform/github/runner-app-id",
  developerAppId: "platform/github/developer-app-id",
  designerAppId: "platform/github/designer-app-id",
  qaAppId: "platform/github/qa-app-id",
  runnerAppInstallationId: "platform/github/runner-app-installation-id",
} as const;
