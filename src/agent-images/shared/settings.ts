// An agent image's settings, from its environment only (ADR 0111). The Kubernetes runtime writes
// them into the agent Job (src/adapters/agent-runtime/kubernetes/manifests.ts). A bad or missing
// setting stops the run before any model call, and the error names the setting, never its value.
import { readConfig, text, type Setting } from "../../service-kit/config.ts";
import type { AgentRole } from "../../adapters/agent-runtime/runtime.ts";

/** Which runtime an image carries. Each image accepts only its own roles. */
export type ImageKind = "claude-code" | "claude-api" | "opencode";

export const ROLES_BY_IMAGE: Record<ImageKind, readonly AgentRole[]> = {
  "claude-code": ["developer", "designer"],
  "claude-api": ["qa", "council", "triage"],
  // D-222: OpenCode replaces Claude Code for these roles; the Claude Code image stays a fallback.
  opencode: ["developer", "designer"],
};

/**
 * Which API a model provider speaks, for a runtime that serves several providers (the OpenCode
 * image). The Kubernetes runtime passes it in FOREMAN_MODEL_API, beside FOREMAN_MODEL_BASE_URL.
 */
export const MODEL_APIS = ["anthropic", "openai-compatible"] as const;
export type ModelApi = (typeof MODEL_APIS)[number];

/**
 * What the agent holds instead of a model credential (ADR 0106 section 5). The egress proxy
 * removes it and adds the real one, so this value never reaches a provider. It is still treated
 * as a secret: it is never printed.
 */
export const PLACEHOLDER_CREDENTIAL =
  "foreman-placeholder-the-egress-proxy-adds-the-key";

export interface ImageSettings {
  runId: string;
  role: AgentRole;
  model: string;
  maxTurns: number;
  maxUsd: number;
  taskFile: string;
  /**
   * The egress proxy's address for the model provider: ANTHROPIC_BASE_URL for the Claude images
   * (e.g. http://10.0.0.1:8080/anthropic), FOREMAN_MODEL_BASE_URL with the API's path for the
   * OpenCode image (e.g. http://10.0.0.1:8080/deepinfra/v1/openai).
   */
  modelBaseUrl: string;
  /** The OpenCode image only: which API the provider speaks (FOREMAN_MODEL_API). */
  modelApi?: ModelApi;
  /** The state API through the proxy (D-195). */
  stateApiUrl: string;
  stateApiToken: string;
  /** The writable work folder (`emptyDir`). */
  workDir: string;
}

/**
 * A provider's model id: Anthropic's (`claude-sonnet-5-5`) or an open model's on DeepInfra, which
 * names its owner (`Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo`). At most one `/`, and each part
 * starts with a letter or digit, so an id is never a path such as `..`.
 */
const MODEL =
  /^(?=.{1,200}$)[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function oneOf<T extends string>(
  env: string,
  allowed: readonly T[],
  problem: string,
): Setting<T> {
  return {
    env,
    parse: (raw) => {
      if (!allowed.includes(raw as T)) throw new Error(problem);
      return raw as T;
    },
  };
}

function matching(env: string, pattern: RegExp, problem: string): Setting<string> {
  return {
    env,
    parse: (raw) => {
      if (!pattern.test(raw)) throw new Error(problem);
      return raw;
    },
  };
}

function positiveInteger(env: string): Setting<number> {
  return {
    env,
    parse: (raw) => {
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
        throw new Error("is not a whole number above 0");
      }
      return value;
    },
  };
}

function positiveAmount(env: string): Setting<number> {
  return {
    env,
    parse: (raw) => {
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
        throw new Error("is not an amount above 0");
      }
      return value;
    },
  };
}

/** A plain http(s) URL with no credentials, query or fragment. */
export function baseUrl(env: string): Setting<string> {
  return {
    env,
    parse: (raw) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error("is not a URL");
      }
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        throw new Error(
          "must be an http(s) URL with no credentials, query or fragment",
        );
      }
      return raw.replace(/\/+$/, "");
    },
  };
}

export function readImageSettings(
  kind: ImageKind,
  env: NodeJS.ProcessEnv = process.env,
): ImageSettings {
  const run = {
    runId: matching("FOREMAN_RUN_ID", RUN_ID, "is not a run id"),
    role: oneOf("FOREMAN_ROLE", ROLES_BY_IMAGE[kind], "is not a role this image runs"),
    model: matching("FOREMAN_MODEL", MODEL, "is not a model id"),
    maxTurns: positiveInteger("FOREMAN_MAX_TURNS"),
    maxUsd: positiveAmount("FOREMAN_MAX_BUDGET_USD"),
    taskFile: text("FOREMAN_TASK_FILE"),
  };
  const stateApi = {
    stateApiUrl: baseUrl("FOREMAN_STATE_API_URL"),
    stateApiToken: text("FOREMAN_STATE_API_TOKEN"),
    workDir: text("HOME"),
  };
  if (kind === "opencode") {
    // OpenCode serves any provider, so it is told which API the provider speaks and the proxy's
    // address for it, API path included. ANTHROPIC_BASE_URL is not read.
    return readConfig(
      {
        ...run,
        modelApi: oneOf("FOREMAN_MODEL_API", MODEL_APIS, "is not a model API"),
        modelBaseUrl: baseUrl("FOREMAN_MODEL_BASE_URL"),
        ...stateApi,
      },
      env,
    );
  }
  return readConfig(
    { ...run, modelBaseUrl: baseUrl("ANTHROPIC_BASE_URL"), ...stateApi },
    env,
  );
}

/**
 * Every credential value the run may see, for redaction (ADR 0106 section 5). Each is removed
 * from anything the image prints.
 */
export function secretValues(
  settings: Pick<ImageSettings, "stateApiToken">,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    settings.stateApiToken,
    env.GITHUB_TOKEN ?? "",
    PLACEHOLDER_CREDENTIAL,
  ].filter((value) => value.length > 0);
}
