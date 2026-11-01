// The state API's routes (build plan M1.4, ADR 0102). A thin shell over the library: it checks
// who is calling and what that role may do, then records what the caller reports. No route
// changes a node's state; only the runner moves nodes, through the library (essential 1).
import type { IncomingMessage, ServerResponse } from "node:http";

import { LibraryError, type Clock, type Library } from "../core/library.ts";
import {
  StoreConflictError,
  type AgentRole,
  type DecisionKind,
  type EdgeType,
  type Json,
  type Node,
  type StoreOps,
} from "../core/store.ts";
import { pathOnly, sendJson, type RequestHandler } from "../service-kit/server.ts";
import { authenticate, type Caller } from "./auth.ts";
import { IDEA_ENTRY } from "./entry.ts";

/** Request bodies above this size are refused before parsing. */
export const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Body = Record<string, unknown>;

interface Route {
  method: "GET" | "POST";
  /** Matched against the path; captured groups are passed to the handler. */
  path: RegExp;
  roles: readonly AgentRole[];
  handle(
    ctx: RouteContext,
    params: string[],
  ): Promise<{ status: number; body: unknown }>;
}

interface RouteContext {
  caller: Caller;
  body: () => Promise<Body>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function text(body: Body, key: string, max: number, required = true): string | null {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${key} is required`);
    return null;
  }
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new HttpError(
      400,
      `${key} must be a non-empty string of at most ${max} characters`,
    );
  }
  return value;
}

function id(body: Body, key: string, required = true): string | null {
  const value = text(body, key, 36, required);
  if (value !== null && !UUID.test(value))
    throw new HttpError(400, `${key} must be a UUID`);
  return value;
}

function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[]): T {
  const value = body[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(400, `${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function json(body: Body, key: string): Json {
  const value = body[key];
  return value === undefined ? {} : (value as Json);
}

async function readBody(request: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body is too large");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return parsed as Body;
}

/** Evidence kinds the runner writes from sources it reads itself; only these can back a verdict. */
const RUNNER_EVIDENCE = new Set([
  "ci_run",
  "test_report",
  "preview_check",
  "staging_check",
  "visual_comparison",
  "merge_commit",
  "spec_paths",
  "dispatch_record",
]);

/**
 * Decision kinds the API records. Approvals and gate answers come only through the approval
 * channel, and a `council_decision` only from the runner, which validates the Council's
 * structured answer (D-228, D-230).
 */
const API_DECISION_KINDS: readonly DecisionKind[] = [
  "interview_answer",
  "product_direction",
];

interface Finding {
  path: string;
  startLine: number;
  endLine: number;
  note: string;
}

function findings(body: Body): Finding[] {
  const value = body.findings ?? [];
  if (!Array.isArray(value) || value.length > 200) {
    throw new HttpError(400, "findings must be a list of at most 200 items");
  }
  return value.map((raw: unknown, index) => {
    const f = (raw ?? {}) as Body;
    const startLine = f.startLine;
    const endLine = f.endLine;
    if (
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      (startLine as number) < 1 ||
      (endLine as number) < (startLine as number)
    ) {
      throw new HttpError(
        400,
        `findings[${index}] needs startLine >= 1 and endLine >= startLine`,
      );
    }
    return {
      path: text(f, "path", 500) as string,
      startLine: startLine as number,
      endLine: endLine as number,
      note: text(f, "note", 2000) as string,
    };
  });
}

function ids(body: Body, key: string): string[] {
  const value = body[key] ?? [];
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    !value.every((v) => typeof v === "string" && UUID.test(v))
  ) {
    throw new HttpError(400, `${key} must be a list of at most 50 UUIDs`);
  }
  return value as string[];
}

export interface ApiOptions {
  store: StoreOps;
  library: Library;
  clock: Clock;
}

export function createApiHandler({
  store,
  library,
  clock,
}: ApiOptions): RequestHandler {
  /** A node the caller may see: it exists and belongs to the caller's project, or 404. */
  async function nodeInProject(caller: Caller, nodeId: string): Promise<Node> {
    const node = await store.getNode(nodeId);
    if (!node || node.projectId !== caller.projectId)
      throw new HttpError(404, "node not found");
    return node;
  }

  /** An agent working on one node may only report on that node. */
  function ownNode(caller: Caller, nodeId: string): void {
    if (caller.run.nodeId !== null && caller.run.nodeId !== nodeId) {
      throw new HttpError(403, "this run may only report on its own node");
    }
  }

  const routes: Route[] = [
    {
      method: "POST",
      path: /^\/ideas$/,
      roles: ["council", "triage"],
      async handle({ caller, body }) {
        const input = await body();
        const node = await library.createNode({
          projectId: caller.projectId,
          type: "idea",
          track: null,
          state: IDEA_ENTRY.state,
          ownerRole: IDEA_ENTRY.ownerRole,
          title: text(input, "title", 500) as string,
          body: json(input, "body"),
        });
        return { status: 201, body: { node } };
      },
    },
    {
      method: "POST",
      path: /^\/edges$/,
      roles: ["council", "triage"],
      async handle({ caller, body }) {
        const input = await body();
        const from = await nodeInProject(caller, id(input, "fromNode") as string);
        const to = await nodeInProject(caller, id(input, "toNode") as string);
        const type = oneOf<EdgeType>(input, "type", [
          "blocks",
          "split_into",
          "design_for",
        ]);
        return {
          status: 201,
          body: { edge: await library.addEdge(from.id, to.id, type) },
        };
      },
    },
    {
      method: "POST",
      path: /^\/reports$/,
      roles: ["developer", "designer", "qa", "council", "triage"],
      async handle({ caller, body }) {
        const input = await body();
        // QA writes only its verdict and agent reports (ADR 0112).
        const kinds =
          caller.role === "qa"
            ? (["agent_report"] as const)
            : (["agent_report", "docs_note"] as const);
        const kind = oneOf(input, "kind", kinds);
        const node = await nodeInProject(caller, id(input, "nodeId") as string);
        ownNode(caller, node.id);
        const evidence = await library.recordEvidence({
          nodeId: node.id,
          runId: caller.run.id,
          kind,
          ref: text(input, "ref", 500) as string,
          // An agent's word about a commit is never trusted evidence (essential 6).
          commitSha: null,
          payload: json(input, "payload"),
          recordedBy: caller.role,
        });
        return { status: 201, body: { evidenceId: evidence.id } };
      },
    },
    {
      method: "POST",
      path: /^\/qa-verdicts$/,
      roles: ["qa"],
      async handle({ caller, body }) {
        const input = await body();
        const node = await nodeInProject(caller, id(input, "nodeId") as string);
        ownNode(caller, node.id);
        // The commit comes from the run's dispatch record, never from the agent (ADR 0112).
        const headSha = caller.run.headSha;
        if (caller.run.nodeId !== node.id || headSha === null) {
          throw new HttpError(
            422,
            "this run was not dispatched to review this node's head commit",
          );
        }
        const claimed = text(input, "commitSha", 40, false);
        if (claimed !== null && claimed !== headSha) {
          throw new HttpError(
            422,
            "commitSha does not match the commit this run was dispatched for",
          );
        }
        const verdict = oneOf(input, "verdict", ["pass", "fail"] as const);
        const cited = ids(input, "evidenceIds");
        if (verdict === "pass" && cited.length === 0) {
          throw new HttpError(
            422,
            "a pass must cite the runner's evidence it relied on",
          );
        }
        const usable = new Map(
          (await store.listEvidence({ nodeId: node.id, commitSha: headSha }))
            .filter((e) => RUNNER_EVIDENCE.has(e.kind))
            .map((e) => [e.id, e]),
        );
        const unknown = cited.filter((evidenceId) => !usable.has(evidenceId));
        if (unknown.length > 0) {
          throw new HttpError(
            422,
            "evidenceIds must name runner evidence for this node and commit",
          );
        }
        const evidence = await library.recordEvidence({
          nodeId: node.id,
          runId: caller.run.id,
          kind: "qa_verdict",
          ref: `run:${caller.run.id}`,
          commitSha: headSha,
          payload: {
            verdict,
            findings: findings(input),
            evidenceIds: cited,
          } as unknown as Json,
          recordedBy: caller.role,
        });
        return { status: 201, body: { evidenceId: evidence.id, commitSha: headSha } };
      },
    },
    {
      method: "POST",
      path: /^\/decisions$/,
      roles: ["council", "triage"],
      async handle({ caller, body }) {
        const input = await body();
        const nodeId = id(input, "nodeId", false);
        if (nodeId !== null) await nodeInProject(caller, nodeId);
        const decision = await library.recordDecision({
          projectId: caller.projectId,
          nodeId,
          kind: oneOf(input, "kind", API_DECISION_KINDS),
          scope: json(input, "scope"),
          // Recorded exactly as given (decisions are verbatim); the recorder is the caller's role.
          textVerbatim: text(input, "text", 20_000) as string,
          byActor: caller.role,
        });
        return { status: 201, body: { decisionId: decision.id } };
      },
    },
    {
      method: "GET",
      path: /^\/nodes\/([^/]+)$/,
      roles: ["developer", "designer", "qa", "council", "triage"],
      async handle({ caller }, [nodeId]) {
        if (!nodeId || !UUID.test(nodeId)) throw new HttpError(404, "node not found");
        return { status: 200, body: { node: await nodeInProject(caller, nodeId) } };
      },
    },
    {
      method: "GET",
      path: /^\/attention$/,
      roles: ["council", "triage"],
      async handle({ caller }) {
        const gateRequests = (
          await store.listOpenGateRequests(caller.projectId)
        ).filter((g) => g.blocking);
        // Blocked and escalated nodes always carry a reason (schema invariant 4).
        const nodes = (await store.listNodes({ projectId: caller.projectId })).filter(
          (n) => n.blockedReason !== null,
        );
        return { status: 200, body: { gateRequests, nodes } };
      },
    },
  ];

  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const path = pathOnly(request.url);
    const route = routes.find((r) => r.method === request.method && r.path.test(path));
    if (!route) return false;
    try {
      const caller = await authenticate(
        store,
        request.headers.authorization,
        clock.now(),
      );
      if (!caller) throw new HttpError(401, "unauthorized");
      if (!route.roles.includes(caller.role))
        throw new HttpError(403, "this role may not do that");
      const params = (route.path.exec(path) ?? []).slice(1);
      const result = await route.handle(
        { caller, body: () => readBody(request) },
        params,
      );
      sendJson(response, result.status, result.body);
    } catch (error) {
      if (error instanceof HttpError)
        sendJson(response, error.status, { error: error.message });
      else if (error instanceof LibraryError)
        sendJson(response, 422, { error: error.message });
      else if (error instanceof StoreConflictError) {
        sendJson(response, 409, { error: "conflicts with an existing record" });
      } else throw error;
    }
    return true;
  };
}
