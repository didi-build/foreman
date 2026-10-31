// What a flow reads from its host (build plan M3.1, ADR 0111 section 4). Secrets are asked for by
// path, never by a variable of their own: Windmill resources now, Vault later. Plain values are
// settings that are not secret, such as the cluster address. The Windmill binding is in
// ./windmill.ts; tests pass a fake.

export interface FlowEnvironment {
  /** The secret at `path`. Never logged, never returned in a flow result. */
  secret(path: string): Promise<string>;
  /** A plain, non-secret value by name. */
  value(name: string): Promise<string>;
  /** This month's Windmill executions, read from Windmill's API (D-167). */
  executionsThisMonth(): Promise<number>;
}

/** Every secret path the flows read. `flows/windmill.yaml` lists the same paths. */
export const SECRET_PATHS = {
  /** A login user in the `factory_runner` role (ADR 0104). New at first hosting. */
  database: "platform/state-store/runner-database-url",
  /** The runner's cluster token (ADR 0106 section 1, first-hosting runbook step 8). */
  clusterToken: "platform/agent-cluster/runner-token",
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
  /** Runtime and bot version per role as JSON, until bot files are loaded. The route names the model. */
  botProfiles: "bot_profiles",
} as const;
