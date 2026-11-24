// The per-run OpenCode config (docs/spikes/opencode-runtime.md, "What the image needs"). Pure: the
// same settings and task give the same config. It names one provider, ours, at the run's egress
// proxy route with a placeholder key, so nothing from OpenCode's bundled model list is merged in
// and the agent never holds a credential (ADR 0106 section 5). The model gets the run's catalog
// prices, so OpenCode's own cost figure matches the wrapper's.
//
// A task that lists context tools (ADR 0119 slice 3c) gets one local MCP server, `foreman`: the
// image's own ./context-mcp.ts, started by OpenCode with Node and the listed tools as its
// arguments. It reads the state API's address and the run's token from the environment OpenCode
// passes on to it, so the token is never in this file.
import type { ServiceTier } from "../../core/store.ts";
import type { TierPrice } from "../../core/routing.ts";
import type { RunPrice } from "../shared/price.ts";
import { PLACEHOLDER_CREDENTIAL, type ModelApi } from "../shared/settings.ts";
import type { AgentTaskFile } from "../shared/task.ts";
import { mcpBlock, type McpBlock } from "./magicpath.ts";
import {
  CONTEXT_MCP_SERVER,
  openCodePermissions,
  type Permissions,
} from "./permissions.ts";
import type { OpenCodeSettings } from "./settings.ts";

/** Our provider id. Not one of OpenCode's built-in ids, so no bundled entry is merged into it. */
export const PROVIDER_ID = "foreman";

/** The AI SDK package OpenCode loads for each API (both are bundled in the binary). */
const SDK_PACKAGE: Record<ModelApi, string> = {
  anthropic: "@ai-sdk/anthropic",
  "openai-compatible": "@ai-sdk/openai-compatible",
};

/**
 * The catalog has no context size per model yet. OpenCode reads a context of 0 as "unknown" and
 * then never starts an automatic compaction (O-27); the proxy's request ceiling and the run's
 * limits hold meanwhile.
 */
export const CONTEXT_LIMIT_UNKNOWN = 0;

interface ModelCost {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** OpenCode's local MCP server entry: a command it starts and speaks to over stdio. */
export interface LocalMcpServer {
  type: "local";
  command: string[];
  enabled: true;
  timeout: number;
}

/** The `mcp` block: MagicPath's remote server and the context tools' local one, by key. */
export type McpServers = Partial<
  McpBlock & Record<typeof CONTEXT_MCP_SERVER, LocalMcpServer>
>;

/** How the wrapper starts the context tools' server: Node by its path, then the server's file. */
export interface ContextServerLaunch {
  node: string;
  script: string;
}

/** Each MCP request's wait, as MagicPath's. OpenCode's default is 5 seconds. */
const CONTEXT_MCP_TIMEOUT_MS = 10_000;

export interface OpenCodeConfig {
  autoupdate: false;
  share: "disabled";
  snapshot: false;
  lsp: false;
  formatter: false;
  enabled_providers: string[];
  model: string;
  small_model: string;
  provider: Record<
    string,
    {
      npm: string;
      options: { baseURL: string; apiKey: string };
      models: Record<
        string,
        {
          tool_call: true;
          limit: { context: number; output: number };
          cost: ModelCost;
          options?: Record<string, string>;
        }
      >;
    }
  >;
  permission: Permissions;
  instructions: string[];
  agent: { build: { steps: number } };
  mcp?: McpServers;
}

/**
 * The tier the wrapper prices every step at: Priority when the route asked for it and the
 * provider supports it, Standard otherwise. OpenCode reports no served tier, and Flex never bills
 * above Standard, so the cap never counts a step below what it can cost (O-28).
 */
export function capTier(price: RunPrice, requested: ServiceTier): ServiceTier | null {
  return requested === "priority" && price.tiers.includes("priority")
    ? "priority"
    : null;
}

function costTable(price: TierPrice): ModelCost {
  return {
    input: price.input,
    output: price.output,
    cache_read: price.cachedInput,
    // A cache write with no listed price is priced at the uncached input rate (O-26).
    cache_write: price.cacheWrite ?? price.input,
  };
}

export function openCodeConfig(
  settings: Pick<
    OpenCodeSettings,
    | "runId"
    | "role"
    | "model"
    | "maxTurns"
    | "modelApi"
    | "modelBaseUrl"
    | "serviceTier"
    | "price"
    | "maxOutputTokens"
    | "magicPathUrl"
  >,
  task: Pick<AgentTaskFile, "allowedTools" | "contextTools">,
  instructionsPath: string,
  magicPathEnabled?: boolean,
  contextServer?: ContextServerLaunch,
): OpenCodeConfig {
  const contextTools = task.contextTools ?? [];
  const permission = openCodePermissions(
    settings.role,
    task.allowedTools ?? [],
    contextTools,
  );
  if (contextTools.length > 0 && contextServer === undefined) {
    throw new Error("the context tools need their server's command");
  }
  const mcp: McpServers = {
    ...mcpBlock(settings.role, settings.magicPathUrl, magicPathEnabled),
    ...(contextTools.length > 0 && contextServer
      ? {
          [CONTEXT_MCP_SERVER]: {
            type: "local" as const,
            command: [contextServer.node, contextServer.script, ...contextTools],
            enabled: true as const,
            timeout: CONTEXT_MCP_TIMEOUT_MS,
          },
        }
      : {}),
  };
  const tier = capTier(settings.price, settings.serviceTier) ?? "standard";
  const tierPrice = settings.price.pricePerMTok[tier];
  // parseRunPrice guarantees a Standard price and one for a requested, supported tier.
  if (!tierPrice)
    throw new Error("FOREMAN_MODEL_PRICE has no price for the capped tier");
  const modelOptions: Record<string, string> = {
    // Only for a route that asked for Flex or Priority: Standard is every provider's default
    // and Anthropic does not take `standard` as a value (O-21).
    ...(settings.serviceTier === "standard"
      ? {}
      : { service_tier: settings.serviceTier }),
    // DeepInfra caches by prefix on its own; a run-scoped key improves the hit rate (D-185).
    ...(settings.modelApi === "openai-compatible"
      ? { prompt_cache_key: settings.runId }
      : {}),
  };
  const model = `${PROVIDER_ID}/${settings.model}`;
  return {
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    lsp: false,
    formatter: false,
    enabled_providers: [PROVIDER_ID],
    model,
    small_model: model,
    provider: {
      [PROVIDER_ID]: {
        npm: SDK_PACKAGE[settings.modelApi],
        options: { baseURL: settings.modelBaseUrl, apiKey: PLACEHOLDER_CREDENTIAL },
        models: {
          [settings.model]: {
            tool_call: true,
            limit: { context: CONTEXT_LIMIT_UNKNOWN, output: settings.maxOutputTokens },
            cost: costTable(tierPrice),
            ...(Object.keys(modelOptions).length > 0 ? { options: modelOptions } : {}),
          },
        },
      },
    },
    permission,
    instructions: [instructionsPath],
    // Advisory only: on the last step OpenCode tells the model to stop using tools. The wrapper
    // enforces the turn limit itself (./limits.ts).
    agent: { build: { steps: settings.maxTurns } },
    ...(Object.keys(mcp).length === 0 ? {} : { mcp }),
  };
}
