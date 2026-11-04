// Test helper: an in-memory stand-in for the few GitHub REST endpoints the OpenCode wrapper uses
// (N-44): read a branch, list a branch's pull requests, read the repository, open a pull request,
// and for the close-only mode (D-318) read one pull request, comment on it and close it.
// It is a plain HTTP request handler, never bound to a port of its own: the fake egress proxy
// hands it each CONNECT tunnel (./fake-proxy.ts). No real GitHub and no network.
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface GitHubCall {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
}

export interface FakePull {
  number: number;
  state: "open" | "closed";
  head: { ref: string; repo: { full_name: string } };
  base: { ref: string };
  title: string;
  body: string;
  /** Set for a merged one (its state is then closed). */
  merged?: boolean;
}

export interface FakeGitHub {
  repository: string;
  defaultBranch: string;
  /** Pushed branches and their head commits. */
  branches: Map<string, string>;
  pulls: FakePull[];
  /** Comments posted on a pull request, by its number. */
  comments: { number: number; body: string }[];
  calls: GitHubCall[];
  /** A status to answer instead, by `METHOD /path` with the query left out. */
  failures: Map<string, number>;
  /** The HTTP server the proxy hands tunnels to. Not listening. */
  server: Server;
}

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
}

export function createFakeGitHub(repository: string): FakeGitHub {
  const state: Omit<FakeGitHub, "server"> = {
    repository,
    defaultBranch: "main",
    branches: new Map(),
    pulls: [],
    comments: [],
    calls: [],
    failures: new Map(),
  };
  const repo = `/repos/${repository}`;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://api.github.com");
      const call: GitHubCall = {
        method: request.method ?? "",
        path: `${url.pathname}${url.search}`,
        headers: request.headers,
        body: await readBody(request),
      };
      state.calls.push(call);
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const failure = state.failures.get(`${call.method} ${url.pathname}`);
      if (failure !== undefined) return send(failure, { message: "scripted failure" });
      if (call.method === "GET" && url.pathname.startsWith(`${repo}/branches/`)) {
        const name = decodeURIComponent(url.pathname.slice(`${repo}/branches/`.length));
        const sha = state.branches.get(name);
        return sha === undefined
          ? send(404, { message: "Branch not found" })
          : send(200, { name, commit: { sha } });
      }
      if (call.method === "GET" && url.pathname === `${repo}/pulls`) {
        const head = url.searchParams.get("head") ?? "";
        const wanted = url.searchParams.get("state") ?? "open";
        const [owner] = repository.split("/");
        return send(
          200,
          state.pulls.filter(
            (p) =>
              (wanted === "all" || p.state === wanted) &&
              `${owner}:${p.head.ref}` === head,
          ),
        );
      }
      if (call.method === "GET" && url.pathname === repo) {
        return send(200, {
          full_name: repository,
          default_branch: state.defaultBranch,
        });
      }
      if (call.method === "POST" && url.pathname === `${repo}/pulls`) {
        const body = call.body ?? {};
        const head = String(body.head);
        if (state.pulls.some((p) => p.state === "open" && p.head.ref === head)) {
          return send(422, { message: "A pull request already exists" });
        }
        const pull: FakePull = {
          number: 100 + state.pulls.length + 1,
          state: "open",
          head: { ref: head, repo: { full_name: repository } },
          base: { ref: String(body.base) },
          title: String(body.title),
          body: String(body.body),
        };
        state.pulls.push(pull);
        return send(201, pull);
      }
      const rest = url.pathname.startsWith(`${repo}/`)
        ? url.pathname.slice(repo.length)
        : "";
      const one = /^\/pulls\/(\d+)$/.exec(rest);
      const pull = one
        ? state.pulls.find((p) => p.number === Number(one[1]))
        : undefined;
      const shown = (p: FakePull) => ({ ...p, merged: p.merged === true });
      if (call.method === "GET" && one) {
        return pull ? send(200, shown(pull)) : send(404, { message: "Not Found" });
      }
      if (call.method === "PATCH" && one && pull) {
        if (call.body?.state === "closed") pull.state = "closed";
        return send(200, shown(pull));
      }
      const commented = /^\/issues\/(\d+)\/comments$/.exec(rest);
      if (call.method === "POST" && commented) {
        const number = Number(commented[1]);
        if (!state.pulls.some((p) => p.number === number))
          return send(404, { message: "Not Found" });
        state.comments.push({ number, body: String(call.body?.body) });
        return send(201, { id: state.comments.length });
      }
      return send(404, { message: "Not Found" });
    })();
  });
  return Object.assign(state, { server });
}
