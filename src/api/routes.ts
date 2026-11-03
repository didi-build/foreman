// The state API's routes (build plan M1.4, ADR 0102). A thin shell over the library: it checks
// who is calling and what that role may do, then records what the caller reports. No route
// changes a node's state; only the runner moves nodes, through the library (essential 1).
//
// The planning chat's identity (D-266, ./auth.ts) may call `POST /plans` and nothing else, and no
// run token may call `POST /plans`. Every other route refuses a planning caller with 403.
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  LibraryError,
  type Clock,
  type IdSource,
  type Library,
} from "../core/library.ts";
import { createPlanSubmissions, readPlanSubmission } from "../core/plans.ts";
import {
  OUT_OF_SCOPE_FINDINGS,
  readOutOfScopeFindings,
  type OutOfScopeFinding,
} from "../core/out-of-scope-findings.ts";
import {
  StoreConflictError,
  type AgentRole,
  type DecisionKind,
  type EdgeType,
  type Json,
  type Node,
  type Store,
  type StoreOps,
} from "../core/store.ts";
import { pathOnly, sendJson, type RequestHandler } from "../service-kit/server.ts";
import { authenticate, isPlanningCaller, type Caller } from "./auth.ts";
import { ENTRY_CONTRACTS, IDEA_ENTRY } from "./entry.ts";

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

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The commit a report names: a full 40-hex sha, on a `docs_note` only (D-236). */
function reportCommit(body: Body, kind: string): string | null {
  const value = body.commitSha;
  if (value === undefined || value === null) return null;
  if (kind !== "docs_note") {
    throw new HttpError(400, "commitSha is accepted on a docs_note only");
  }
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new HttpError(400, "commitSha must be a full 40-character lowercase hex sha");
  }
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

/**
 * QA's optional bugs seen outside the PR (D-244, O-65), checked strictly. They are kept with the
 * verdict as QA gave them; the runner creates ideas from the run's result, not from this row.
 */
function outOfScopeFindings(body: Body): OutOfScopeFinding[] {
  const read = readOutOfScopeFindings(body[OUT_OF_SCOPE_FINDINGS]);
  if ("problem" in read) throw new HttpError(400, read.problem);
  return read.findings;
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
  /**
   * The planning chat's identity (D-266): the SHA-256 of its token, and the id source its
   * submissions are recorded with. Left out, no planning token is accepted.
   */
  planning?: { tokenSha256: string; ids: IdSource; store: Store };
}

/** The planning chat's only route (D-266). */
const PLANS_PATH = /^\/plans$/;

const SUBMIT_REFUSALS = {
  no_project: { status: 404, error: "project not found" },
  no_idea: { status: 404, error: "idea not found" },
  not_submittable: {
    status: 409,
    error: "the idea is not waiting for a plan (Submitted or Council planning)",
  },
} as const;

export function createApiHandler({
  store,
  library,
  clock,
  planning,
}: ApiOptions): RequestHandler {
  const submissions = planning
    ? createPlanSubmissions({
        store: planning.store,
        contracts: ENTRY_CONTRACTS,
        clock,
        ids: planning.ids,
      })
    : null;

  /** `POST /plans` for the planning chat: one checked submission, recorded once (D-266). */
  async function submitPlan(request: IncomingMessage) {
    if (!submissions) throw new HttpError(401, "unauthorized");
    const read = readPlanSubmission(await readBody(request));
    if ("problem" in read) throw new HttpError(400, read.problem);
    const recorded = await submissions.submit(read.submission);
    if (!recorded.recorded) {
      const refusal = SUBMIT_REFUSALS[recorded.reason];
      throw new HttpError(refusal.status, refusal.error);
    }
    return {
      status: 201,
      body: { ideaId: recorded.ideaId, created: recorded.created },
    };
  }
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
        // A docs note may name the commit it covers: the PR head the OpenCode wrapper read from
        // GitHub (D-236). A docs note is the agent's own statement, and `docs_updated_or_none`
        // counts it only when that commit is the head the runner recorded. Any other kind never
        // stores a commit from an agent (essential 6).
        const commitSha = reportCommit(input, kind);
        const node = await nodeInProject(caller, id(input, "nodeId") as string);
        ownNode(caller, node.id);
        const evidence = await library.recordEvidence({
          nodeId: node.id,
          runId: caller.run.id,
          kind,
          ref: text(input, "ref", 500) as string,
          commitSha,
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
        const outside = outOfScopeFindings(input);
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
            ...(outside.length === 0 ? {} : { [OUT_OF_SCOPE_FINDINGS]: outside }),
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
    const plans = request.method === "POST" && PLANS_PATH.test(path);
    const route = routes.find((r) => r.method === request.method && r.path.test(path));
    if (!route && !plans) return false;
    try {
      const planningCaller = isPlanningCaller(
        request.headers.authorization,
        planning?.tokenSha256 ?? null,
      );
      if (plans) {
        if (planningCaller) {
          const result = await submitPlan(request);
          sendJson(response, result.status, result.body);
          return true;
        }
        // A run token is never the planning chat (D-266).
        const agent = await authenticate(
          store,
          request.headers.authorization,
          clock.now(),
        );
        throw agent
          ? new HttpError(403, "this role may not do that")
          : new HttpError(401, "unauthorized");
      }
      if (!route) return false;
      // The planning chat may call nothing but `POST /plans` (D-266).
      if (planningCaller) throw new HttpError(403, "this role may not do that");
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
