// Starts a Windmill script by its path, without waiting for it to run (D-283, D-284, D-291, D-328,
// O-101). The state API and the GitHub receiver use it, each with its own narrow token. The call
// goes only through the shared Windmill egress proxy in HTTPS_PROXY: a CONNECT tunnel to the
// Windmill host on port 443, the one host that proxy allows, then TLS inside the tunnel with the
// system's certificate authorities, checked against the Windmill host's name. The proxy holds no
// credential and never decrypts the tunnel. The start resolves once Windmill accepts it (any 2xx).
//
// The token goes in the Authorization header as a bearer token and nowhere else. Neither the
// token nor Windmill's answer is read into a log line, a result or an error: an error names the
// step and the status only (`WindmillStartError`). What only a real Windmill can confirm is listed
// in O-101 and in the first-hosting runbook under "To verify at rehearsal".
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

import type { Json } from "../../core/store.ts";
import { secretEnvName, type Setting } from "../../service-kit/config.ts";
import type { LogFields } from "../../service-kit/logger.ts";

/**
 * Windmill's endpoint that starts a script by its path and answers at once with the job's id.
 * `flows/windmill.yaml` pushes each entry as a script, so this is the script form (`run/p/`); a
 * flow would be `run/f/`. The one place to fix if rehearsal shows otherwise (O-101).
 */
export const RUN_BY_PATH_ENDPOINT = "/api/w/{workspace}/jobs/run/p/{path}";

/** The scope a token needs to start one script by path ("Limit token permissions", O-101). */
export const runScope = (path: string): string => `jobs:run:scripts:${path}`;

/** The environment variables both services read for their Windmill start. None is secret. */
export const WINDMILL_ENV = {
  host: "WINDMILL_HOST",
  workspace: "WINDMILL_WORKSPACE",
  /** The shared Windmill egress proxy (D-328), as agent images name theirs. */
  proxy: "HTTPS_PROXY",
} as const;

const TLS_PORT = 443;

/** The whole start, tunnel included. A webhook is still answered within GitHub's 10 seconds. */
export const WINDMILL_START_TIMEOUT_MS = 5_000;

/** Where a start goes: the Windmill host and workspace, through the proxy. Not secret. */
export interface WindmillTarget {
  host: string;
  workspace: string;
  /** The shared Windmill egress proxy, `http://<host>:<port>`. */
  proxy: URL;
}

/** A part a service cannot use yet. The message says what it waits on, never a value. */
export class NotBuiltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotBuiltError";
  }
}

export type WindmillStartStep = "tunnel" | "start";

/** A start Windmill did not accept. Only the step and the status, never the token or a body. */
export class WindmillStartError extends Error {
  readonly step: WindmillStartStep;
  /** The proxy's answer to the tunnel, or Windmill's to the start; null when none came. */
  readonly status: number | null;

  constructor(step: WindmillStartStep, status: number | null) {
    super(
      `Windmill did not accept the start at the ${step} step (${
        status === null ? "no answer" : `status ${status}`
      })`,
    );
    this.name = "WindmillStartError";
    this.step = step;
    this.status = status;
  }
}

/** What a failed start may log: the error's type, and this client's step and status. No text. */
export function startErrorFields(error: unknown): LogFields {
  const errorType = error instanceof Error ? error.name : typeof error;
  return error instanceof WindmillStartError
    ? { errorType, step: error.step, status: error.status }
    : { errorType };
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;
const SCRIPT_PATH = /^[fu](?:\/[A-Za-z0-9_-]+){2,}$/;

/** The Windmill host: a plain lower-case DNS name, no scheme, port, path or IP address. */
export function parseWindmillHost(raw: string): string {
  const labels = raw.split(".");
  const plain =
    raw.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => HOST_LABEL.test(label)) &&
    !/^[0-9]+$/.test(labels.at(-1) ?? "");
  if (!plain)
    throw new Error("is not a plain host name (no scheme, port, path or IP address)");
  return raw;
}

export function parseWindmillWorkspace(raw: string): string {
  if (!WORKSPACE.test(raw))
    throw new Error("is not a workspace id (letters, digits, - and _)");
  return raw;
}

/** HTTPS_PROXY: `http://<host>:<port>` and nothing else. */
export function parseProxyUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("is not a URL");
  }
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("must be http://<host>:<port> with nothing else");
  }
  return url;
}

/**
 * A Windmill token read from its secret path (ADR 0111 section 4): null while the secret is unset
 * or empty, so the service starts and the start is refused until the token exists.
 */
export function windmillTokenSetting(path: string): Setting<string | null> {
  return {
    env: secretEnvName(path),
    fallback: "",
    parse: (raw) => {
      const token = raw.trim();
      if (token === "") return null;
      if (!/^[\x21-\x7e]+$/.test(token))
        throw new Error("is not a token of visible ASCII characters");
      return token;
    },
  };
}

/** Every setting a service reads for its Windmill start, the token by its secret path. */
export function windmillSettings(tokenPath: string) {
  return {
    windmillToken: windmillTokenSetting(tokenPath),
    windmillHost: { env: WINDMILL_ENV.host, parse: parseWindmillHost },
    windmillWorkspace: { env: WINDMILL_ENV.workspace, parse: parseWindmillWorkspace },
    windmillProxy: { env: WINDMILL_ENV.proxy, parse: parseProxyUrl },
  } satisfies Record<string, Setting<unknown>>;
}

export const windmillTargetOf = (config: {
  windmillHost: string;
  windmillWorkspace: string;
  windmillProxy: URL;
}): WindmillTarget => ({
  host: config.windmillHost,
  workspace: config.windmillWorkspace,
  proxy: config.windmillProxy,
});

/** The run endpoint for one script in one workspace. Refuses anything that is not a plain path. */
export function runByPath(workspace: string, path: string): string {
  if (!WORKSPACE.test(workspace) || !SCRIPT_PATH.test(path)) {
    throw new Error("not a Windmill workspace and script path");
  }
  return RUN_BY_PATH_ENDPOINT.replace("{workspace}", workspace).replace("{path}", path);
}

/**
 * The arguments of a flow entry's `main(input)`, by name. Windmill passes a script's arguments by
 * parameter name, and every entry in flows/ takes one argument called `input` (O-101).
 */
export const entryArgs = (input: Record<string, Json>): Record<string, Json> => ({
  input,
});

export interface WindmillScripts {
  /** Starts the script at `path` with `args`. Resolves once Windmill accepts the start. */
  start(path: string, args: Record<string, Json>): Promise<void>;
}

export interface WindmillClientOptions {
  target: WindmillTarget;
  token: string;
  /** Test seam: certificate authorities to trust instead of the system's. Never set in a service. */
  ca?: string;
  timeoutMs?: number;
}

export function windmillScripts(options: WindmillClientOptions): WindmillScripts {
  const { target, token } = options;
  const timeoutMs = options.timeoutMs ?? WINDMILL_START_TIMEOUT_MS;
  const authority = `${target.host}:${TLS_PORT}`;

  return {
    start: async (path, args) => {
      const endpoint = runByPath(target.workspace, path);
      const body = JSON.stringify(args);
      await new Promise<void>((resolve, reject) => {
        let step: WindmillStartStep = "tunnel";
        let tunnel: Socket | undefined;
        let settled = false;
        const connect = httpRequest({
          host: target.proxy.hostname,
          port: target.proxy.port === "" ? 80 : Number(target.proxy.port),
          method: "CONNECT",
          path: authority,
          headers: { host: authority },
        });
        // Every call to `finish` comes from an event or this timer, after both are set.
        const timer = setTimeout(
          () => finish(new WindmillStartError(step, null)),
          timeoutMs,
        );
        const finish = (error?: WindmillStartError): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          connect.destroy();
          tunnel?.destroy();
          if (error) reject(error);
          else resolve();
        };

        // Errors are listened to with `on`: a late second error after `finish` must not reach
        // the process as an unhandled one.
        connect.on("error", () => finish(new WindmillStartError("tunnel", null)));
        connect.once("connect", (answer: IncomingMessage, socket: Socket) => {
          tunnel = socket;
          socket.on("error", () => finish(new WindmillStartError(step, null)));
          if (answer.statusCode !== 200) {
            finish(new WindmillStartError("tunnel", answer.statusCode ?? null));
            return;
          }
          step = "start";
          const secure = tlsConnect({
            socket,
            servername: target.host,
            host: target.host,
            port: TLS_PORT,
            ...(options.ca === undefined ? {} : { ca: options.ca }),
          });
          secure.on("error", () => finish(new WindmillStartError("start", null)));
          try {
            const request = httpRequest({
              host: target.host,
              method: "POST",
              path: endpoint,
              headers: {
                host: target.host,
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body, "utf8")),
                "user-agent": "foreman-windmill-start",
                connection: "close",
              },
              createConnection: () => secure,
            });
            request.on("error", () => finish(new WindmillStartError("start", null)));
            request.once("response", (response: IncomingMessage) => {
              const status = response.statusCode ?? 0;
              // The answer (the job's id) is never read.
              response.resume();
              finish(
                status >= 200 && status < 300
                  ? undefined
                  : new WindmillStartError("start", status),
              );
            });
            request.end(body);
          } catch {
            finish(new WindmillStartError("start", null));
          }
        });
        connect.end();
      });
    },
  };
}
