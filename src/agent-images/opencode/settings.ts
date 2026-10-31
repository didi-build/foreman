// The OpenCode image's settings (D-222, D-223): the shared image settings plus what the wrapper
// needs to write OpenCode's config and enforce the run's limits. Everything comes from the
// environment (ADR 0111). A missing or bad setting stops the run before anything is written or
// started, and the error names the setting, never its value.
import type { ServiceTier } from "../../core/store.ts";
import { readConfig, type Setting } from "../../service-kit/config.ts";
import { parseRunPrice, type RunPrice } from "../shared/price.ts";
import {
  readImageSettings,
  type ImageSettings,
  type ModelApi,
} from "../shared/settings.ts";

const TIERS: readonly ServiceTier[] = ["standard", "flex", "priority"];

/** DeepInfra caps output at 16,384 tokens; OpenCode's own default (32,000) is above it. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;

export interface OpenCodeSettings extends ImageSettings {
  modelApi: ModelApi;
  /** The tier the run's route asked for (ADR 0114 section 8). */
  serviceTier: ServiceTier;
  /** The run's catalog price (FOREMAN_MODEL_PRICE), for the dollar cap and OpenCode's cost table. */
  price: RunPrice;
  /** OpenCode's `limit.output` for the model. */
  maxOutputTokens: number;
  /** The pinned binary's absolute path (FOREMAN_OPENCODE_CLI, set by the Dockerfile). */
  cliPath: string;
  /**
   * The read-only folder OpenCode gets as XDG_CONFIG_HOME (FOREMAN_OPENCODE_CONFIG_HOME, set by
   * the Dockerfile). It holds `opencode/.gitignore`, so OpenCode installs nothing at start.
   */
  configHome: string;
  /** FOREMAN_MAGICPATH_URL, when set. Refused while MagicPath is off (./magicpath.ts). */
  magicPathUrl: string | undefined;
}

const absolutePath = (env: string): Setting<string> => ({
  env,
  parse: (raw) => {
    if (!raw.startsWith("/")) throw new Error("must be an absolute path");
    return raw;
  },
});

const extraSettings = {
  serviceTier: {
    env: "FOREMAN_SERVICE_TIER",
    parse: (raw: string) => {
      if (!TIERS.includes(raw as ServiceTier)) throw new Error("is not a service tier");
      return raw as ServiceTier;
    },
  } satisfies Setting<ServiceTier>,
  maxOutputTokens: {
    env: "FOREMAN_MAX_OUTPUT_TOKENS",
    fallback: String(DEFAULT_MAX_OUTPUT_TOKENS),
    parse: (raw: string) => {
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || value < 1 || value > 128_000) {
        throw new Error("is not a whole number from 1 to 128000");
      }
      return value;
    },
  } satisfies Setting<number>,
  cliPath: absolutePath("FOREMAN_OPENCODE_CLI"),
  configHome: absolutePath("FOREMAN_OPENCODE_CONFIG_HOME"),
  magicPathUrl: {
    env: "FOREMAN_MAGICPATH_URL",
    fallback: "",
    parse: (raw: string) => (raw === "" ? undefined : raw),
  } satisfies Setting<string | undefined>,
};

export function readOpenCodeSettings(env: NodeJS.ProcessEnv): OpenCodeSettings {
  const image = readImageSettings("opencode", env);
  const extra = readConfig(extraSettings, env);
  // The price is checked against the requested tier, so it is read once the tier is known. Without
  // a usable price the dollar cap cannot be enforced: the run fails closed (ADR 0114 section 5).
  const { price } = readConfig(
    {
      price: {
        env: "FOREMAN_MODEL_PRICE",
        parse: (raw: string) => parseRunPrice(raw, extra.serviceTier),
      },
    },
    env,
  );
  if (image.modelApi === undefined) throw new Error("FOREMAN_MODEL_API is not set");
  return { ...image, modelApi: image.modelApi, ...extra, price };
}
