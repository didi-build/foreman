// The planning chat's plan, and Didi's one-tap approval of it (D-266, D-230, D-254). Plain logic
// over an injected store, contracts, guards, clock and id source (D-162).
//
// The submission. The planning chat has its own narrow identity in the state API, which can only
// call `POST /plans` (src/api/routes.ts). A submission names the project by its slug and carries
// the idea's title, the final plan, the product direction and Didi's answers from the chat, each a
// bounded verbatim text (`readPlanSubmission`). `submit` records it in one transaction, and only
// inserts: a new idea in Submitted (owned by the runner), or, with `ideaId`, an idea of the project
// already in Submitted or Council planning (a resubmission after Didi asked for changes); the
// product direction as a `product_direction` decision and each of Didi's answers as an
// `interview_answer` decision on the idea, recorded by `planning`; and the submission itself as an
// `agent_report` on the idea by `planning`, with no run, whose payload holds the plan and the rest
// exactly as sent. It never moves the idea, never opens a gate request (the state API's database
// role cannot) and never records `plan_accepted` (D-230).
//
// The approval. The runner (`createPlanApprovals`) opens one plan-approval request for Didi per
// submission: kind `scope` (Didi decides scope, spec section 5; no guard reads that kind),
// blocking, on `plan-approval:<idea id>`, with the plan, the direction and the answers in its
// payload and no options, so the approval form of D-254 shows Decision and Feedback only. A newer
// submission supersedes an open request. Didi's answer is recorded by the approval resume step as
// on any request. On Approve the runner applies the runner-only move into Plan accepted, guarded
// by `plan_approval_recorded`, and records `plan_accepted` in the move's transaction: a
// `council_decision` with `scope.kind` `plan_accepted` whose text is the plan Didi approved,
// exactly as the request showed it. Triage then starts as M3.6 built. On Reject or Request
// changes (feedback required, D-254) Didi's words are recorded, and an idea in Submitted takes the
// runner-only move back to Council planning (`plan_return_recorded`), where the planning chat can
// resubmit; an idea already in Council planning stays there. Each step reads the kill switch and
// dry run as every runner step does, and is taken once per submission and answer.
import type { Contracts, GuardRegistry } from "./contracts.ts";
import { latest } from "./guards/evidence.ts";
import {
  createLibrary,
  type Clock,
  type IdSource,
  type TransitionOutcome,
} from "./library.ts";
import type {
  Decision,
  Evidence,
  GateKind,
  GateRequest,
  Json,
  Node,
  Store,
  StoreOps,
} from "./store.ts";

/** Who records a submission: the planning chat's identity (D-266). */
export const PLANNING_ACTOR = "planning";

/** The idea states a submission may come in: a new idea, or one sent back to planning. */
export const SUBMITTED_STATE = "submitted";
export const COUNCIL_PLANNING_STATE = "council_planning";
export const PLAN_ACCEPTED_STATE = "plan_accepted";
const SUBMITTABLE_STATES: readonly string[] = [SUBMITTED_STATE, COUNCIL_PLANNING_STATE];

/** The topic of an idea's plan-approval request. */
export const PLAN_APPROVAL_PREFIX = "plan-approval:";
export const planApprovalTopic = (ideaId: string): string =>
  `${PLAN_APPROVAL_PREFIX}${ideaId}`;

/** The gate kind of a plan-approval request: Didi's scope call (spec section 5). */
export const PLAN_APPROVAL_KIND: GateKind = "scope";

/** The fixed question on every plan-approval request. */
export const PLAN_APPROVAL_QUESTION =
  "The planning chat submitted this plan. Approve to accept it and start Triage; Request changes or Reject, with feedback, to send it back to planning.";

/** The submission's marker in its `agent_report` payload. */
export const PLAN_SUBMISSION_KIND = "plan_submission";

/** The bounds of a submission. The state API also caps the whole body at 64 KiB. */
export const PLAN_LIMITS = {
  slugChars: 100,
  titleChars: 300,
  planChars: 40_000,
  directionChars: 8_000,
  answers: 30,
  questionChars: 1_000,
  answerChars: 4_000,
} as const;

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PlanAnswer {
  question: string;
  answer: string;
}

/** A checked submission, every text exactly as sent. */
export interface PlanSubmission {
  projectSlug: string;
  ideaId: string | null;
  title: string;
  plan: string;
  productDirection: string;
  answers: PlanAnswer[];
}

const FIELDS = new Set([
  "projectSlug",
  "ideaId",
  "title",
  "plan",
  "productDirection",
  "answers",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A non-blank text of at most `max` characters, or null. */
const textWithin = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= max
    ? value
    : null;

/**
 * Checks a submission's body. Returns the submission, or the first problem as a fixed sentence
 * that names the field only, never its value. Unknown fields are refused, so nothing but these
 * texts can be sent.
 */
export function readPlanSubmission(
  body: unknown,
): { submission: PlanSubmission } | { problem: string } {
  if (!isObject(body)) return { problem: "the body must be a JSON object" };
  const unknown = Object.keys(body).filter((key) => !FIELDS.has(key));
  if (unknown.length > 0) {
    return {
      problem: `unknown fields; only ${[...FIELDS].join(", ")} are accepted`,
    };
  }
  const L = PLAN_LIMITS;
  const slug = textWithin(body.projectSlug, L.slugChars);
  if (slug === null || !SLUG.test(slug)) {
    return { problem: "projectSlug must be a project's slug" };
  }
  let ideaId: string | null = null;
  if (body.ideaId !== undefined && body.ideaId !== null) {
    if (typeof body.ideaId !== "string" || !UUID.test(body.ideaId)) {
      return { problem: "ideaId must be a UUID" };
    }
    ideaId = body.ideaId;
  }
  const title = textWithin(body.title, L.titleChars);
  if (title === null || /[\r\n]/.test(title)) {
    return {
      problem: `title must be one non-blank line of at most ${L.titleChars} characters`,
    };
  }
  const plan = textWithin(body.plan, L.planChars);
  if (plan === null) {
    return {
      problem: `plan must be a non-blank text of at most ${L.planChars} characters`,
    };
  }
  const productDirection = textWithin(body.productDirection, L.directionChars);
  if (productDirection === null) {
    return {
      problem: `productDirection must be a non-blank text of at most ${L.directionChars} characters`,
    };
  }
  const rawAnswers = body.answers ?? [];
  if (!Array.isArray(rawAnswers) || rawAnswers.length > L.answers) {
    return { problem: `answers must be a list of at most ${L.answers} items` };
  }
  const answers: PlanAnswer[] = [];
  for (const [index, raw] of rawAnswers.entries()) {
    const keys = isObject(raw) ? Object.keys(raw).sort().join(",") : "";
    const question = isObject(raw) ? textWithin(raw.question, L.questionChars) : null;
    const answer = isObject(raw) ? textWithin(raw.answer, L.answerChars) : null;
    if (keys !== "answer,question" || question === null || answer === null) {
      return {
        problem: `answers[${index}] must have exactly a question of at most ${L.questionChars} characters and an answer of at most ${L.answerChars}, both non-blank`,
      };
    }
    answers.push({ question, answer });
  }
  return {
    submission: { projectSlug: slug, ideaId, title, plan, productDirection, answers },
  };
}

/** Why a submission could not be recorded, as a fixed reason the API maps to its status. */
export type SubmitRefusal = "no_project" | "no_idea" | "not_submittable";

export type SubmitResult =
  | { recorded: true; ideaId: string; created: boolean }
  | { recorded: false; reason: SubmitRefusal };

/** A submission's record: the `agent_report` the planning chat's identity writes. */
export function isPlanSubmission(evidence: Evidence): boolean {
  return (
    evidence.kind === "agent_report" &&
    evidence.recordedBy === PLANNING_ACTOR &&
    evidence.runId === null &&
    isObject(evidence.payload) &&
    evidence.payload.kind === PLAN_SUBMISSION_KIND
  );
}

/** The idea's latest submission, if any. */
export async function latestSubmission(
  store: Pick<StoreOps, "listEvidence">,
  ideaId: string,
): Promise<Evidence | undefined> {
  return latest(
    (await store.listEvidence({ nodeId: ideaId, kind: "agent_report" })).filter(
      isPlanSubmission,
    ),
  );
}

/** The newest request on the idea's plan-approval topic, whatever its status. */
export async function newestPlanRequest(
  store: Pick<StoreOps, "listGateRequests">,
  idea: Pick<Node, "id" | "projectId">,
): Promise<GateRequest | undefined> {
  const requests = await store.listGateRequests(
    idea.projectId,
    planApprovalTopic(idea.id),
  );
  return [...requests].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

const payloadOf = (request: GateRequest | undefined): Record<string, Json> =>
  isObject(request?.payload) ? (request.payload as Record<string, Json>) : {};

/** The submission a plan-approval request shows. */
export const requestSubmissionId = (request: GateRequest | undefined): unknown =>
  payloadOf(request).submissionId;

/** The plan a plan-approval request shows, exactly as submitted. */
export const requestPlan = (request: GateRequest | undefined): string | null => {
  const plan = payloadOf(request).plan;
  return typeof plan === "string" ? plan : null;
};

export interface PlanSubmissionOptions {
  store: Store;
  contracts: Contracts;
  clock: Clock;
  ids: IdSource;
}

/** Records the planning chat's submissions (the state API's side, D-266). */
export function createPlanSubmissions(options: PlanSubmissionOptions) {
  const { store, clock, ids } = options;
  const library = createLibrary({ ...options, guards: {} });

  return {
    /** Records one checked submission in one transaction that only inserts. */
    async submit(submission: PlanSubmission): Promise<SubmitResult> {
      const project = await store.getProjectBySlug(submission.projectSlug);
      if (!project) return { recorded: false, reason: "no_project" };
      return store.transaction(async (tx): Promise<SubmitResult> => {
        let idea: Node;
        let created = false;
        if (submission.ideaId !== null) {
          const found = await tx.getNode(submission.ideaId);
          if (!found || found.type !== "idea" || found.projectId !== project.id) {
            return { recorded: false, reason: "no_idea" };
          }
          if (!SUBMITTABLE_STATES.includes(found.state)) {
            return { recorded: false, reason: "not_submittable" };
          }
          idea = found;
        } else {
          idea = await library.createNodeWith(tx, {
            projectId: project.id,
            type: "idea",
            track: null,
            state: SUBMITTED_STATE,
            ownerRole: "runner",
            title: submission.title,
            body: { source: "planning_chat" },
          });
          created = true;
        }
        const at = clock.now();
        const decision = (
          fields: Pick<Decision, "kind" | "scope" | "textVerbatim">,
        ) => ({
          ...fields,
          id: ids.next(),
          projectId: project.id,
          nodeId: idea.id,
          byActor: PLANNING_ACTOR,
          recordedAt: at,
        });
        const direction = decision({
          kind: "product_direction",
          scope: { source: "planning_chat" },
          textVerbatim: submission.productDirection,
        });
        await tx.insertDecision(direction);
        const answerIds: string[] = [];
        for (const [index, answer] of submission.answers.entries()) {
          const recorded = decision({
            kind: "interview_answer",
            scope: { source: "planning_chat", index, question: answer.question },
            textVerbatim: answer.answer,
          });
          await tx.insertDecision(recorded);
          answerIds.push(recorded.id);
        }
        const evidenceId = ids.next();
        await tx.insertEvidence({
          id: evidenceId,
          nodeId: idea.id,
          runId: null,
          kind: "agent_report",
          ref: `planning:plan_submission:${evidenceId}`,
          commitSha: null,
          payload: {
            kind: PLAN_SUBMISSION_KIND,
            title: submission.title,
            plan: submission.plan,
            productDirection: submission.productDirection,
            answers: submission.answers as unknown as Json,
            directionDecisionId: direction.id,
            answerDecisionIds: answerIds,
          },
          recordedBy: PLANNING_ACTOR,
          recordedAt: at,
          supersedesId: null,
        });
        return { recorded: true, ideaId: idea.id, created };
      });
    },
  };
}

/** What the runner did for one idea's plan approval. */
export type PlanApprovalStep =
  | {
      ideaId: string;
      step: "opened";
      gateRequestId: string;
    }
  | {
      ideaId: string;
      step: "accepted" | "returned";
      move: { outcome: TransitionOutcome; reason?: string };
    }
  | {
      ideaId: string;
      step:
        | "no_idea"
        | "not_planning"
        | "no_submission"
        | "waiting"
        | "kept_in_planning"
        | "closed_unanswered"
        | "kill_switch"
        | "dry_run";
    };

export interface PlanApprovalOptions {
  store: Store;
  contracts: Contracts;
  guards: GuardRegistry;
  clock: Clock;
  ids: IdSource;
}

const ACTOR = { kind: "runner" as const, id: "plan_approval" };
/** The triggers of the two moves, keyed by Didi's answer, so each is taken once. */
export const PLAN_APPROVED_TRIGGER = "plan_approved:";
export const PLAN_RETURNED_TRIGGER = "plan_returned:";

/** The runner's side: the request, and the moves on Didi's answer (D-266). */
export function createPlanApprovals(options: PlanApprovalOptions) {
  const { store, ids, clock } = options;
  const library = createLibrary(options);

  async function stopped(tx: StoreOps): Promise<"kill_switch" | "dry_run" | null> {
    if ((await tx.getSetting("kill_switch"))?.value === true) return "kill_switch";
    if ((await tx.getSetting("dry_run"))?.value !== false) return "dry_run";
    return null;
  }

  /** Opens the request for the idea's latest submission; locks only the idea, up front. */
  function open(ideaId: string): Promise<PlanApprovalStep> {
    return store.transaction(async (tx): Promise<PlanApprovalStep> => {
      const stop = await stopped(tx);
      if (stop) return { ideaId, step: stop };
      const idea = await tx.getNodeForUpdate(ideaId);
      if (!idea || idea.type !== "idea") return { ideaId, step: "no_idea" };
      if (!SUBMITTABLE_STATES.includes(idea.state)) {
        return { ideaId, step: "not_planning" };
      }
      const submission = await latestSubmission(tx, idea.id);
      if (!submission) return { ideaId, step: "no_submission" };
      const newest = await newestPlanRequest(tx, idea);
      if (newest && requestSubmissionId(newest) === submission.id) {
        return { ideaId, step: "waiting" };
      }
      const sent: Record<string, Json> = isObject(submission.payload)
        ? (submission.payload as Record<string, Json>)
        : {};
      const request = await library.openGateRequestWith(tx, {
        projectId: idea.projectId,
        nodeId: idea.id,
        topicKey: planApprovalTopic(idea.id),
        kind: PLAN_APPROVAL_KIND,
        owner: "didi",
        blocking: true,
        payload: {
          question: PLAN_APPROVAL_QUESTION,
          title: sent.title ?? idea.title,
          plan: sent.plan ?? "",
          productDirection: sent.productDirection ?? "",
          answers: sent.answers ?? [],
          ideaId: idea.id,
          submissionId: submission.id,
        },
      });
      return { ideaId, step: "opened", gateRequestId: request.id };
    });
  }

  /** The move into Plan accepted, with `plan_accepted` recorded in its transaction (D-230). */
  async function accept(idea: Node, request: GateRequest, answer: Decision) {
    const plan = requestPlan(request);
    return library.requestTransitionOnce(
      {
        nodeId: idea.id,
        toState: PLAN_ACCEPTED_STATE,
        trigger: { kind: "event", ref: `${PLAN_APPROVED_TRIGGER}${answer.id}` },
        actor: ACTOR,
        runnerOnly: true,
        reason: "Didi approved the plan",
      },
      async (tx) => {
        if (plan === null) return "the approved request shows no plan";
        await tx.insertDecision({
          id: ids.next(),
          projectId: idea.projectId,
          nodeId: idea.id,
          kind: "council_decision",
          scope: {
            kind: "plan_accepted",
            topicKey: request.topicKey,
            gateRequestId: request.id,
            approvalDecisionId: answer.id,
            submissionId: requestSubmissionId(request) as Json,
            recordedBy: "runner",
          },
          textVerbatim: plan,
          byActor: "council",
          recordedAt: clock.now(),
        });
        return null;
      },
    );
  }

  return {
    /** Ideas in Submitted or Council planning with a submission: the ones the pass looks at. */
    async pending(): Promise<string[]> {
      const ideas = [
        ...(await store.listNodes({ state: SUBMITTED_STATE })),
        ...(await store.listNodes({ state: COUNCIL_PLANNING_STATE })),
      ].filter((n) => n.type === "idea");
      const due: string[] = [];
      for (const idea of ideas) {
        if (await latestSubmission(store, idea.id)) due.push(idea.id);
      }
      return due;
    },

    /**
     * One step for the idea: open the request for a new submission, or take the move Didi's
     * answer on the latest one calls for. Repeating it writes nothing more.
     */
    async step(ideaId: string): Promise<PlanApprovalStep> {
      const idea = await store.getNode(ideaId);
      if (!idea || idea.type !== "idea") return { ideaId, step: "no_idea" };
      if (!SUBMITTABLE_STATES.includes(idea.state)) {
        return { ideaId, step: "not_planning" };
      }
      const submission = await latestSubmission(store, idea.id);
      if (!submission) return { ideaId, step: "no_submission" };
      const newest = await newestPlanRequest(store, idea);
      if (!newest || requestSubmissionId(newest) !== submission.id) return open(ideaId);
      if (newest.status === "open") return { ideaId, step: "waiting" };
      if (newest.status !== "answered" || !newest.decisionId) {
        // Expired or cancelled with no answer: reopening is the gate lifecycle (M4.1).
        return { ideaId, step: "closed_unanswered" };
      }
      const answer = await store.getDecision(newest.decisionId);
      if (!answer || answer.status !== "active" || answer.byActor !== "didi") {
        return { ideaId, step: "closed_unanswered" };
      }
      if (answer.kind === "approval") {
        const move = await accept(idea, newest, answer);
        return {
          ideaId,
          step: "accepted",
          move: {
            outcome: move.outcome,
            ...(move.reason ? { reason: move.reason } : {}),
          },
        };
      }
      if (idea.state !== SUBMITTED_STATE) return { ideaId, step: "kept_in_planning" };
      const move = await library.requestTransitionOnce({
        nodeId: idea.id,
        toState: COUNCIL_PLANNING_STATE,
        trigger: { kind: "event", ref: `${PLAN_RETURNED_TRIGGER}${answer.id}` },
        actor: ACTOR,
        runnerOnly: true,
        reason: "Didi sent the plan back to planning",
      });
      return {
        ideaId,
        step: "returned",
        move: {
          outcome: move.outcome,
          ...(move.reason ? { reason: move.reason } : {}),
        },
      };
    },
  };
}

export type PlanApprovals = ReturnType<typeof createPlanApprovals>;
