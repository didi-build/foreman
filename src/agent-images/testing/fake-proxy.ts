// Test helper: a local HTTP server that stands in for a run's egress proxy. It serves enough of
// Anthropic's Messages API at `/anthropic/v1/messages` and the state API's `POST /qa-verdicts` at
// `/state-api/...`, and CONNECT tunnels, which it hands to an in-memory fake GitHub when one is
// given (./fake-github.ts). Replies come from a script, one per model request. It records every
// request so tests can check the body (cache_control, tools) and the headers (no real
// credential). Localhost only: no real model call and no network.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { FakeGitHub } from "./fake-github.ts";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

export interface FakeReply {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface FakeProxy {
  /** The provider's base URL, as ANTHROPIC_BASE_URL. */
  modelBaseUrl: string;
  /** The state API's base URL, as FOREMAN_STATE_API_URL. */
  stateApiUrl: string;
  modelRequests: RecordedRequest[];
  stateApiRequests: RecordedRequest[];
  /** Replies for the next model requests, in order. */
  replies: FakeReply[];
  /** The state API's reply to a verdict. */
  verdictReply: FakeReply;
  /** The state API's reply to `POST /reports`. */
  reportReply: FakeReply;
  /** The proxy's own address, as HTTPS_PROXY. */
  proxyUrl: string;
  /** The `host:port` of each CONNECT request, in order. */
  connectTargets: string[];
  /** How many times `GET /health` was asked (O-133). */
  healthChecks: number;
  close(): Promise<void>;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** The tier the provider says it served. Left out unless a test sets it. */
  service_tier?: string;
}

const DEFAULT_USAGE: Usage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function message(
  content: unknown[],
  stopReason: string,
  usage: Partial<Usage>,
): FakeReply {
  return {
    status: 200,
    body: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "fake",
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { ...DEFAULT_USAGE, ...usage },
    },
  };
}

export const reply = {
  text: (text: string, usage: Partial<Usage> = {}) =>
    message([{ type: "text", text }], "end_turn", usage),
  toolUse: (name: string, input: unknown, id: string, usage: Partial<Usage> = {}) =>
    message([{ type: "tool_use", id, name, input }], "tool_use", usage),
  error: (
    status: number,
    type: string,
    text: string,
    headers: Record<string, string> = {},
  ) => ({
    status,
    headers,
    body: { type: "error", error: { type, message: text } },
  }),
};

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

export async function startFakeProxy(github?: FakeGitHub): Promise<FakeProxy> {
  const state: Omit<FakeProxy, "modelBaseUrl" | "stateApiUrl" | "proxyUrl" | "close"> =
    {
      modelRequests: [],
      stateApiRequests: [],
      replies: [],
      verdictReply: {
        status: 201,
        body: { evidenceId: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", commitSha: "x" },
      },
      reportReply: {
        status: 201,
        body: { evidenceId: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b" },
      },
      connectTargets: [],
      healthChecks: 0,
    };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const recorded: RecordedRequest = {
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body: await readJson(request),
      };
      let out: FakeReply;
      if (recorded.path === "/health" && recorded.method === "GET") {
        // The real proxy's readiness check, which each agent image waits for (O-133).
        state.healthChecks += 1;
        out = { status: 200, body: { status: "ok" } };
      } else if (
        recorded.path === "/anthropic/v1/messages" &&
        recorded.method === "POST"
      ) {
        state.modelRequests.push(recorded);
        out =
          state.replies.shift() ?? reply.error(500, "api_error", "no scripted reply");
      } else if (recorded.path.startsWith("/state-api/")) {
        state.stateApiRequests.push(recorded);
        out =
          recorded.path === "/state-api/reports"
            ? state.reportReply
            : state.verdictReply;
      } else {
        out = { status: 404, body: { error: "not found" } };
      }
      response.writeHead(out.status, {
        "content-type": "application/json",
        ...(out.headers ?? {}),
      });
      response.end(JSON.stringify(out.body));
    })();
  });
  // A CONNECT to api.github.com:443 is answered by the fake GitHub over plain HTTP inside the
  // tunnel (the wrapper's TLS step is replaced in tests). Any other target is refused, as the
  // real proxy refuses a host the bot file does not allow.
  server.on("connect", (request: IncomingMessage, socket) => {
    state.connectTargets.push(request.url ?? "");
    if (!github || request.url !== "api.github.com:443") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    github.server.emit("connection", socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return Object.assign(state, {
    modelBaseUrl: `${base}/anthropic`,
    stateApiUrl: `${base}/state-api`,
    proxyUrl: base,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  });
}
