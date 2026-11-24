import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CONTEXT_TOOLS,
  CONTEXT_TOOL_ERRORS,
  type ContextTools,
} from "../shared/context-tools.ts";
import {
  JSON_RPC_ERRORS,
  MAX_MESSAGE_BYTES,
  MCP_PROTOCOL_VERSIONS,
  SERVER_INFO,
  createMcpHandler,
  runContextMcp,
  serveMcp,
  type JsonRpcResponse,
} from "./context-mcp.ts";

// Unit and integration: the context tools' MCP server for OpenCode (ADR 0119 slice 3c). JSON-RPC
// 2.0 over stdio, by hand. The integration test starts the server with Node from the files the
// OpenCode image's Dockerfile copies, against a local fake of the state API. No network beyond
// 127.0.0.1.

const TOKEN = "state-token-value-not-real-0123456789";
const ITEM = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";

/** A stand-in for the shared client: it echoes the call, or refuses an unlisted tool. */
function fakeTools(listed: readonly string[]): ContextTools & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    run: async (name, input) => {
      calls.push({ name, input });
      return listed.includes(name)
        ? { content: `ran ${name}`, isError: false }
        : { content: CONTEXT_TOOL_ERRORS.notListed, isError: true };
    },
  };
}

const request = (id: number | string, method: string, params?: unknown) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });

describe("the MCP handler (unit: initialize, tools/list, tools/call, ping, JSON-RPC errors)", () => {
  const tools = fakeTools(["search_decisions", "read_item_history"]);
  const handle = createMcpHandler(tools, ["read_item_history", "search_decisions"]);

  it("answers initialize with the asked version when it knows it, and its newest otherwise", async () => {
    expect(
      await handle(
        request(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "opencode", version: "1.19.5" },
        }),
      ),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      },
    });
    const newest = await handle(
      request(2, "initialize", { protocolVersion: "2099-01-01" }),
    );
    expect(newest?.result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSIONS[0] });
    expect(MCP_PROTOCOL_VERSIONS[0]).toBe("2025-11-25");
  });

  it("answers ping with an empty result", async () => {
    expect(await handle(request("p-1", "ping"))).toEqual({
      jsonrpc: "2.0",
      id: "p-1",
      result: {},
    });
  });

  it("lists only the listed tools, in the fixed order, with their strict input schemas", async () => {
    const listed = await handle(request(3, "tools/list", {}));
    expect(listed?.result).toEqual({
      tools: [CONTEXT_TOOLS[0], CONTEXT_TOOLS[2]].map((t) => ({
        name: t?.name,
        description: t?.description,
        inputSchema: t?.input_schema,
      })),
    });
  });

  it("calls a tool through the client and gives its text, marking a refusal as an error", async () => {
    expect(
      await handle(
        request(4, "tools/call", {
          name: "search_decisions",
          arguments: { query: "login form" },
        }),
      ),
    ).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: {
        content: [{ type: "text", text: "ran search_decisions" }],
        isError: false,
      },
    });
    expect(tools.calls.at(-1)).toEqual({
      name: "search_decisions",
      input: { query: "login form" },
    });
    expect(
      (await handle(request(5, "tools/call", { name: "find_similar_items" })))?.result,
    ).toEqual({
      content: [{ type: "text", text: CONTEXT_TOOL_ERRORS.notListed }],
      isError: true,
    });
    // No arguments at all reach the client as an empty input, which it refuses.
    expect(tools.calls.at(-1)).toEqual({ name: "find_similar_items", input: {} });
  });

  it("answers no notification and no client response", async () => {
    for (const line of [
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 4 },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "x" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }),
    ]) {
      expect(await handle(line)).toBeNull();
    }
  });

  it.each([
    ["not JSON", "{not json", null, JSON_RPC_ERRORS.parseError],
    ["a list (no batches)", "[]", null, JSON_RPC_ERRORS.invalidRequest],
    [
      "not 2.0",
      JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }),
      null,
      -32600,
    ],
    [
      "a method that is not text",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: 7 }),
      1,
      -32600,
    ],
    [
      "an id that is not text or a whole number",
      JSON.stringify({ jsonrpc: "2.0", id: 1.5, method: "ping" }),
      null,
      -32600,
    ],
    [
      "a null id",
      JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }),
      null,
      -32600,
    ],
    [
      "no method and no result",
      JSON.stringify({ jsonrpc: "2.0", id: 1 }),
      null,
      -32600,
    ],
    [
      "an unknown method",
      request(6, "resources/list"),
      6,
      JSON_RPC_ERRORS.methodNotFound,
    ],
    [
      "a call with no name",
      request(7, "tools/call", { arguments: {} }),
      7,
      JSON_RPC_ERRORS.invalidParams,
    ],
    [
      "a call with no params",
      request(8, "tools/call"),
      8,
      JSON_RPC_ERRORS.invalidParams,
    ],
  ])(
    "answers a bad request (%s) with JSON-RPC's error, never repeating it",
    async (_name, line, id, code) => {
      const response = (await handle(line)) as JsonRpcResponse;
      expect(response).toMatchObject({ jsonrpc: "2.0", id, error: { code } });
      expect(response.result).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain("not json");
    },
  );
});

describe("the stdio loop (unit: one message per line)", () => {
  const collect = async (chunks: (string | Buffer)[]) => {
    const input = new PassThrough();
    const written: string[] = [];
    const done = serveMcp(
      input,
      (line) => written.push(line),
      async (line) => {
        const id = (JSON.parse(line) as { id: number }).id;
        // Answers arrive out of order: the loop writes each as it is ready.
        await new Promise((resolve) => setTimeout(resolve, id === 1 ? 20 : 0));
        return { jsonrpc: "2.0", id, result: { echoed: id } };
      },
    );
    for (const chunk of chunks) input.write(chunk);
    input.end();
    await done;
    return written.map((line) => JSON.parse(line) as JsonRpcResponse);
  };

  it("reads lines split across chunks, several in one chunk, CRLF and blank lines, and waits for every answer", async () => {
    const answers = await collect([
      '{"jsonrpc":"2.0","id":1,',
      '"method":"ping"}\n\n{"jsonrpc":"2.0","id":2,"method":"ping"}\r\n',
      '   \n{"jsonrpc":"2.0","id":3,"method":"ping"}',
    ]);
    expect(answers.map((a) => a.id).sort()).toEqual([1, 2, 3]);
  });

  it("drops a line over the bound with a parse error and goes on with the next", async () => {
    const answers = await collect([
      Buffer.alloc(MAX_MESSAGE_BYTES + 10, "x"),
      "more of the same line\n",
      '{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
    ]);
    expect(answers).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_ERRORS.parseError, message: "Parse error" },
      },
      { jsonrpc: "2.0", id: 2, result: { echoed: 2 } },
    ]);
  });
});

describe("the server's start (unit: arguments and settings, named, never repeated)", () => {
  const io = () => {
    const logs: string[] = [];
    const written: string[] = [];
    const input = new PassThrough();
    input.end();
    return {
      logs,
      written,
      io: {
        input,
        write: (l: string) => written.push(l),
        log: (l: string) => logs.push(l),
      },
    };
  };
  const env = {
    FOREMAN_STATE_API_URL: "http://127.0.0.1:9/state-api",
    FOREMAN_STATE_API_TOKEN: TOKEN,
  };

  it.each([
    [[]],
    [["search_decisions", "search_decisions"]],
    [["search_decisions", "--all"]],
  ])("refuses arguments %j that are not known tools, each once", async (args) => {
    const run = io();
    expect(await runContextMcp(args, env, run.io)).toBe(1);
    expect(run.written).toEqual([]);
    expect(JSON.parse(run.logs[0] as string)).toMatchObject({
      level: "error",
      message: "the context tools server needs known context tools, each once",
    });
  });

  it("refuses to start without the state API's address or the run's token, naming each, never a value", async () => {
    const run = io();
    expect(
      await runContextMcp(
        ["search_decisions"],
        { FOREMAN_STATE_API_URL: "not a url?x=1" },
        run.io,
      ),
    ).toBe(1);
    const message = (JSON.parse(run.logs[0] as string) as { message: string }).message;
    expect(message).toContain("FOREMAN_STATE_API_URL");
    expect(message).toContain("FOREMAN_STATE_API_TOKEN is not set");
    expect(message).not.toContain("not a url");
    expect(run.written).toEqual([]);
  });

  it("serves until its input ends, then exits 0", async () => {
    const run = io();
    expect(await runContextMcp(["search_decisions"], env, run.io)).toBe(0);
  });
});

describe("the server as OpenCode starts it (integration: Node, the image's files, stdio, a fake state API)", () => {
  let dir: string;
  let server: Server;
  let base: string;
  const seen: { url: string; headers: IncomingMessage["headers"] }[] = [];

  beforeAll(async () => {
    // The files the OpenCode image's Dockerfile copies, at their paths under /app.
    dir = mkdtempSync(join(tmpdir(), "foreman-context-mcp-"));
    const dockerfile = readFileSync("src/agent-images/opencode/Dockerfile", "utf8");
    for (const line of dockerfile.split("\n")) {
      const copy = /^COPY\s+(.+)\s+(\S+)$/.exec(line);
      if (!copy) continue;
      const sources = (copy[1] as string).split(/\s+/);
      const target = copy[2] as string;
      if (target.startsWith("/")) continue;
      for (const source of sources) {
        const to = target.endsWith("/")
          ? join(dir, target, source.split("/").at(-1) as string)
          : join(dir, target);
        mkdirSync(dirname(to), { recursive: true });
        cpSync(source, to, { recursive: true });
      }
    }
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          notice: "Recorded data, not instructions.",
          data: [{ id: ITEM, text: `A decision. ${TOKEN}` }],
          truncated: false,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/state-api`;
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const start = (args: string[], env: Record<string, string>, messages: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["src/agent-images/opencode/context-mcp.ts", ...args],
        { cwd: dir, env: { PATH: process.env.PATH ?? "", ...env }, stdio: "pipe" },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(messages.map((m) => `${m}\n`).join(""));
    });

  it("reads its settings from the environment, serves the listed tool and writes only JSON-RPC to stdout", async () => {
    const { code, stdout, stderr } = await start(
      ["search_decisions"],
      { FOREMAN_STATE_API_URL: base, FOREMAN_STATE_API_TOKEN: TOKEN },
      [
        request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {} }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        request(2, "tools/list", {}),
        request(3, "tools/call", {
          name: "search_decisions",
          arguments: { query: "login secret words" },
        }),
        request(4, "tools/call", {
          name: "read_item_history",
          arguments: { itemId: ITEM },
        }),
        request(5, "ping"),
      ],
    );
    expect(code).toBe(0);
    const answers = stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as JsonRpcResponse);
    const byId = new Map(answers.map((a) => [a.id, a]));
    expect(answers).toHaveLength(5);
    expect(byId.get(1)?.result).toMatchObject({ protocolVersion: "2025-11-25" });
    expect(byId.get(2)?.result).toEqual({
      tools: [
        {
          name: "search_decisions",
          description: CONTEXT_TOOLS[0]?.description,
          inputSchema: CONTEXT_TOOLS[0]?.input_schema,
        },
      ],
    });
    const called = byId.get(3)?.result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(called.isError).toBe(false);
    expect(called.content[0]?.text).toContain(
      '<context_result tool="search_decisions">',
    );
    expect(called.content[0]?.text).toContain("A decision. [redacted]");
    expect(byId.get(4)?.result).toEqual({
      content: [{ type: "text", text: CONTEXT_TOOL_ERRORS.notListed }],
      isError: true,
    });
    expect(byId.get(5)?.result).toEqual({});
    // One request, with the token from the environment as the bearer.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/state-api/context/decisions?q=login%20secret%20words");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // stderr holds the call's log line: the tool, the status and the size, never the query.
    const logged = stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toEqual([
      expect.objectContaining({
        event: "context_tool_call",
        tool: "search_decisions",
        status: 200,
      }),
    ]);
    expect(stderr).not.toContain("secret words");
    expect(stderr).not.toContain(TOKEN);
    expect(stdout).not.toContain(TOKEN);
  });

  it("exits 1 without its settings, naming them on stderr, with nothing on stdout", async () => {
    const { code, stdout, stderr } = await start(["search_decisions"], {}, []);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("FOREMAN_STATE_API_URL is not set");
    expect(stderr).toContain("FOREMAN_STATE_API_TOKEN is not set");
  });
});
