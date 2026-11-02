// GitHub's REST API from the OpenCode image's wrapper (N-44, D-235), through the run's egress
// proxy. The pod reaches nothing directly (ADR 0106 section 2), so each request opens a CONNECT
// tunnel to api.github.com:443 on the proxy in HTTPS_PROXY, which allows that host from the bot
// file's `allowed_hosts`, then speaks TLS inside it with the system's certificate authorities.
// The run's GitHub token goes in the Authorization header and nowhere else: it is never in a
// path, a log line or an error. Errors name the step and GitHub's status, never a body.
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

export const GITHUB_API_HOST = "api.github.com";
const TLS_PORT = 443;
/** One request, tunnel included. The pod's deadline still bounds the whole run. */
export const GITHUB_TIMEOUT_MS = 30_000;
/** A GitHub answer the wrapper reads is small; a larger one is cut and reads as not JSON. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface GitHubResponse {
  /** null: GitHub could not be reached (the tunnel was refused, timed out or broke). */
  status: number | null;
  /** The parsed JSON body, or null when there is none or it is not JSON. */
  body: unknown;
}

/** One request to GitHub's API: a path such as `/repos/o/r/pulls`, and a JSON body to send. */
export type GitHubApi = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<GitHubResponse>;

/** Turns the tunnel into the stream the request is written to. Production: TLS to the host. */
export type SecureTunnel = (socket: Socket, host: string) => Duplex;

const TLS: SecureTunnel = (socket, host) =>
  tlsConnect({ socket, servername: host, host, port: TLS_PORT });

class Unreachable extends Error {}

function openTunnel(proxy: URL, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const target = `${GITHUB_API_HOST}:${TLS_PORT}`;
    const connect = httpRequest({
      host: proxy.hostname,
      port: proxy.port === "" ? 80 : Number(proxy.port),
      method: "CONNECT",
      path: target,
      headers: { host: target },
    });
    connect.setTimeout(timeoutMs, () => connect.destroy(new Unreachable()));
    connect.once("connect", (response, socket) => {
      if (response.statusCode === 200) {
        resolve(socket);
        return;
      }
      socket.destroy();
      reject(new Unreachable());
    });
    connect.once("error", () => reject(new Unreachable()));
    connect.end();
  });
}

/**
 * The production client. `proxyUrl` is HTTPS_PROXY (`http://<proxy>:<port>`); `token` is the
 * run's installation token. `secure` is a test seam: the tests' fake proxy tunnels to a plain
 * HTTP fake GitHub, so they pass a function that returns the socket unchanged.
 */
export function proxiedGitHub(options: {
  proxyUrl: string;
  token: string;
  secure?: SecureTunnel;
  timeoutMs?: number;
}): GitHubApi {
  const proxy = new URL(options.proxyUrl);
  const secure = options.secure ?? TLS;
  const timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS;
  return async (method, path, body) => {
    let socket: Socket;
    try {
      socket = await openTunnel(proxy, timeoutMs);
    } catch {
      return { status: null, body: null };
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<GitHubResponse>((resolve) => {
      let settled = false;
      const done = (response: GitHubResponse) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(response);
      };
      const stream = secure(socket, GITHUB_API_HOST);
      stream.once("error", () => done({ status: null, body: null }));
      const request = httpRequest({
        host: GITHUB_API_HOST,
        method,
        path,
        headers: {
          host: GITHUB_API_HOST,
          accept: "application/vnd.github+json",
          authorization: `Bearer ${options.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "foreman-agent-wrapper",
          connection: "close",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload, "utf8")),
              }),
        },
        createConnection: () => stream as Socket,
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Unreachable()));
      request.once("error", () => done({ status: null, body: null }));
      request.once("response", (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        });
        response.once("error", () => done({ status: null, body: null }));
        response.once("end", () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // Not JSON, or cut: the steps read it as no body.
          }
          done({ status: response.statusCode ?? null, body: parsed });
        });
      });
      request.end(payload);
    });
  };
}
