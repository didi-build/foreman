// The read-only context tools' MCP server for OpenCode (ADR 0119 slice 3c, D-459). OpenCode starts
// it as the local server `foreman` of the run's config (./config.ts), with Node, this file and the
// tools the task lists as arguments, and names its tools `foreman_<tool>` (./permissions.ts). It
// speaks JSON-RPC 2.0 over stdio, one message per line, by hand, with no dependency: `initialize`,
// `ping`, `tools/list` and `tools/call`; every notification is read and ignored. Each call goes
// through the shared client (../shared/context-tools.ts), so its framing, refusals, call cap and
// log are a Messages API run's.
//
// The state API's address and the run's token come from the environment OpenCode passes on to its
// local servers (the wrapper's own, ../shared/environment.ts), never from the config file or the
// arguments. A missing setting stops the server at start, naming the setting, and OpenCode then
// runs without these tools. stdout carries only JSON-RPC messages; the call log goes to stderr,
// which OpenCode reads, and holds only the tool, the status code and the answer's size.
import { pathToFileURL } from "node:url";

import {
  isContextToolName,
  type ContextToolName,
} from "../../adapters/agent-runtime/kubernetes/task.ts";
import { readConfig, text } from "../../service-kit/config.ts";
import { createLogger } from "../../service-kit/logger.ts";
import {
  contextToolDefinitions,
  createContextTools,
  type ContextTools,
} from "../shared/context-tools.ts";
import { baseUrl, secretValues } from "../shared/settings.ts";

/** The MCP versions this server answers with, newest first. */
export const MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const SERVER_INFO = { name: "foreman-context-tools", version: "1.0.0" } as const;

/** JSON-RPC 2.0's error codes this server sends. */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** A longer line is dropped unread and answered with a parse error. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

type RequestId = string | number;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: RequestId | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRequestId = (value: unknown): value is RequestId =>
  typeof value === "string" || (typeof value === "number" && Number.isInteger(value));

const failure = (
  id: RequestId | null,
  code: number,
  message: string,
): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * Answers one message: a response for a request, or null for a notification or a client's
 * response, which need none. Errors are JSON-RPC's fixed texts, never a value from the message.
 */
export function createMcpHandler(
  tools: ContextTools,
  listed: readonly ContextToolName[],
): (line: string) => Promise<JsonRpcResponse | null> {
  const definitions = contextToolDefinitions(listed).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
  }));
  return async (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return failure(null, JSON_RPC_ERRORS.parseError, "Parse error");
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return failure(null, JSON_RPC_ERRORS.invalidRequest, "Invalid Request");
    }
    if (!("method" in message)) {
      // A client's response to a request: this server sends none, so there is nothing to do.
      if ("result" in message || "error" in message) return null;
      return failure(null, JSON_RPC_ERRORS.invalidRequest, "Invalid Request");
    }
    const { method, params } = message;
    const notification = !("id" in message);
    if (typeof method !== "string" || (!notification && !isRequestId(message.id))) {
      return failure(
        isRequestId(message.id) ? message.id : null,
        JSON_RPC_ERRORS.invalidRequest,
        "Invalid Request",
      );
    }
    // `notifications/initialized`, `notifications/cancelled` and any other: nothing to answer.
    if (notification) return null;
    const id = message.id as RequestId;
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize": {
        const asked = isRecord(params) ? params.protocolVersion : undefined;
        const version = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked)
          ? (asked as string)
          : MCP_PROTOCOL_VERSIONS[0];
        return ok({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: definitions });
      case "tools/call": {
        if (!isRecord(params) || typeof params.name !== "string") {
          return failure(id, JSON_RPC_ERRORS.invalidParams, "Invalid params");
        }
        const output = await tools.run(params.name, params.arguments ?? {});
        return ok({
          content: [{ type: "text", text: output.content }],
          isError: output.isError,
        });
      }
      default:
        return failure(id, JSON_RPC_ERRORS.methodNotFound, "Method not found");
    }
  };
}

/**
 * Reads one message per line from `input` and writes each response as one line, until `input`
 * ends and every answer is written. A blank line is skipped; a line over `MAX_MESSAGE_BYTES` is
 * dropped and answered with a parse error.
 */
export function serveMcp(
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
  handle: (line: string) => Promise<JsonRpcResponse | null>,
): Promise<void> {
  const pending = new Set<Promise<void>>();
  const answer = (line: string) => {
    const done = handle(line)
      .catch(() => failure(null, JSON_RPC_ERRORS.internalError, "Internal error"))
      .then((response) => {
        if (response !== null) write(JSON.stringify(response));
      })
      .finally(() => pending.delete(done));
    pending.add(done);
  };
  return new Promise((resolve, reject) => {
    let buffered: Buffer[] = [];
    let size = 0;
    let dropping = false;
    const take = (line: Buffer) => {
      const textLine = line.toString("utf8").replace(/\r$/, "");
      if (textLine.trim() !== "") answer(textLine);
    };
    const tooLong = () => {
      write(JSON.stringify(failure(null, JSON_RPC_ERRORS.parseError, "Parse error")));
    };
    input.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      let start = 0;
      for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, start)) {
        if (!dropping) {
          buffered.push(bytes.subarray(start, i));
          take(Buffer.concat(buffered));
        }
        buffered = [];
        size = 0;
        dropping = false;
        start = i + 1;
      }
      if (start < bytes.length && !dropping) {
        buffered.push(bytes.subarray(start));
        size += bytes.length - start;
        if (size > MAX_MESSAGE_BYTES) {
          buffered = [];
          size = 0;
          dropping = true;
          tooLong();
        }
      }
    });
    input.on("error", reject);
    input.on("end", () => {
      if (!dropping && size > 0) take(Buffer.concat(buffered));
      void (async () => {
        while (pending.size > 0) await Promise.all([...pending]);
        resolve();
      })();
    });
  });
}

export interface ContextMcpIo {
  input: NodeJS.ReadableStream;
  /** One JSON-RPC message, without its newline. */
  write: (line: string) => void;
  /** One log line, without its newline. */
  log: (line: string) => void;
}

/**
 * The server's run: its arguments are the listed tools, each known and once, and its settings the
 * state API's address and the run's token. Returns the exit code: 0 once stdin ends, 1 when it
 * cannot start. A refusal names the problem, never a value.
 */
export async function runContextMcp(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: ContextMcpIo,
): Promise<number> {
  const logger = createLogger("agent-context-tools", io.log);
  if (
    args.length === 0 ||
    !args.every(isContextToolName) ||
    new Set(args).size !== args.length
  ) {
    logger.error("the context tools server needs known context tools, each once");
    return 1;
  }
  const listed = args as readonly ContextToolName[];
  let settings: { stateApiUrl: string; token: string };
  try {
    settings = readConfig(
      {
        stateApiUrl: baseUrl("FOREMAN_STATE_API_URL"),
        token: text("FOREMAN_STATE_API_TOKEN"),
      },
      env,
    );
  } catch (error) {
    logger.error(
      error instanceof Error
        ? error.message
        : "the context tools server has no settings",
    );
    return 1;
  }
  const tools = createContextTools({
    stateApiUrl: settings.stateApiUrl,
    token: settings.token,
    allowed: listed,
    secrets: secretValues({ stateApiToken: settings.token }, env),
    log: (entry) => logger.info("context tool call", { ...entry }),
  });
  await serveMcp(io.input, io.write, createMcpHandler(tools, listed));
  return 0;
}

// Run only when started as a program, as OpenCode starts it; importing it starts nothing.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runContextMcp(process.argv.slice(2), process.env, {
    input: process.stdin,
    write: (line) => process.stdout.write(`${line}\n`),
    log: (line) => process.stderr.write(`${line}\n`),
  });
}
