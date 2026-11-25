// A Council discussion in the Messages API image (ADR 0119 slice 6, D-483 to D-490): one run, in
// which each persona of the task's cast speaks once, in a model call of its own, and then
// Product, the chair, answers in the question kind's schema. A run uses it when its Council task
// has a `discussion`, which the runner sets on every Council task since slice 6e (O-181); without
// one, the Council runs as before (./image.ts).
//
// Every call is one loop (./loop.ts) on the same tools, system text and input, so all of them
// share one cached prefix: the tools are `pull_in`, then in tool mode the answer tool; the system
// text is the discussion's frame and the task's instructions (./prompts.ts); the first message's
// first block is the fenced input, with the images of a visual call, and its own cache
// breakpoint. The second block is the call's turn (./discussion-turns.ts), which quotes the views
// so far as data. A view call answers with the view schema and the chair's call with the task's,
// each the way the route's provider takes an answer: structured outputs, or the answer tool
// (O-152). One budget holds for the whole run (D-490): every loop counts into the same spend, so
// the turn, dollar and minute limits and the Flex capacity retries are the run's, not a call's.
//
// Any speaker, the chair too, may call `pull_in` for a persona not yet in the discussion, with a
// one-line reason. The image then runs that persona's view call on the same prefix and returns
// its view as the tool result, and the speaker goes on. A pull-in of a persona already in the
// discussion, with a bad reason, or over the task's limit is refused with a fixed text and
// recorded (D-484). Once one over the limit is refused, the question goes to Didi: the chair's
// turn says so, and when the refusal came inside a pull-in the chair itself asked for, after its
// turn was sent, the view it gets back says so too. A view that does not follow the view schema
// ends the run `error`, which the runner treats as any failed run: one re-run, then Didi (D-228).
//
// The result is the chair's answer as `structured`, as before, and the discussion's record as
// `discussion` (../../core/discussion-record.ts): each view and reason with every secret value
// removed and cut to its bound (D-488).
import type Anthropic from "@anthropic-ai/sdk";

import {
  DISCUSSION_CHAIR,
  MAX_REASON_CHARS,
  MAX_REFUSED_PULL_INS,
  MAX_VIEW_CHARS,
  recordedReason,
  type DiscussionRecord,
  type DiscussionView,
  type PullIn,
  type PullInRefusal,
} from "../../core/discussion-record.ts";
import { PERSONAS, isPersonaId, type PersonaId } from "../../core/personas.ts";
import { errorResult, redact, type AgentResult } from "../shared/result.ts";
import type { AgentTaskFile } from "../shared/task.ts";
import {
  chairTurn,
  overLimitSentence,
  quoteView,
  viewTurn,
  type DiscussionState,
} from "./discussion-turns.ts";
import type { ToolOutput } from "./files.ts";
import {
  realClock,
  runLoop,
  spentResult,
  startSpend,
  type LoopOptions,
} from "./loop.ts";
import { discussionSystemText, fencedInput } from "./prompts.ts";

export const PULL_IN_TOOL_NAME = "pull_in";

/** The personas a speaker may pull in: all but the chair, always the same list. */
const PULLABLE = PERSONAS.filter((persona) => persona !== DISCUSSION_CHAIR);

/** The pull-in tool's last sentence, for the task's limit. */
const LIMIT_SENTENCE: readonly string[] = [
  "This discussion pulls in no personas.",
  "This discussion pulls in at most one persona.",
  "A discussion pulls in at most two personas.",
];

/** The pull-in tool, the same in every call of one discussion (D-484). */
export function pullInTool(maxPullIns: number): Anthropic.Tool {
  return {
    name: PULL_IN_TOOL_NAME,
    description:
      `Bring a persona who is not yet in this discussion into it. Give your reason in one line. The result is that persona's view, as data. ${LIMIT_SENTENCE[maxPullIns] ?? ""}`.trim(),
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["persona", "reason"],
      properties: {
        persona: { type: "string", enum: [...PULLABLE] },
        reason: { type: "string" },
      },
    },
  };
}

/**
 * What a view call answers with. The bound is in the description, since structured outputs take
 * no length limits; the image checks it.
 */
export const VIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["view"],
  properties: {
    view: {
      type: "string",
      description:
        "Your view as the persona named in the request: what you would decide, why, and the risks you see. At most 2,000 characters, with no secret or personal data.",
    },
  },
};

const LIMIT_REFUSAL: readonly string[] = [
  "Not pulled in: this discussion pulls in no personas.",
  "Not pulled in: this discussion already pulled in one persona.",
  "Not pulled in: this discussion already pulled in two personas.",
];

/** The fixed texts a pull-in is refused with (D-484). None repeats the call's input. */
export const PULL_IN_REFUSALS = {
  in_discussion: () => "Not pulled in: that persona is already in this discussion.",
  bad_reason: () =>
    `Not pulled in: give a reason in one line, at most ${MAX_REASON_CHARS} characters.`,
  limit: (maxPullIns: number) =>
    `${LIMIT_REFUSAL[maxPullIns] ?? ""} A question that needs more goes to Didi, so the chair answers with the question's way to Didi.`.trim(),
} satisfies Record<PullInRefusal, (maxPullIns: number) => string>;

/** The fixed texts of a call that is not a pull-in at all. It is not recorded. */
export const DISCUSSION_TOOL_ERRORS = {
  badPersona: `Not pulled in: the persona must be ${PULLABLE.slice(0, -1).join(", ")} or ${PULLABLE.at(-1) ?? ""}.`,
  noSuchTool: "This discussion has no such tool.",
} as const;

/** The fixed error texts a discussion ends a run with (D-385 keeps each whole). */
export const DISCUSSION_ERRORS = {
  task: "a discussion task needs its discussion and its answer schema",
  badView: "a view did not follow the view schema",
  tooManyRefused: "the discussion refused more pull-ins than its record holds",
  notJson: "the answer is not JSON",
} as const;

/**
 * The loop options every call of one discussion shares as they are: the client, the model, the
 * limits, the price, the tier, the effort, the answer mode and the cache key. The discussion sets
 * the rest.
 */
export type DiscussionLoopOptions = Omit<
  LoopOptions,
  | "system"
  | "tools"
  | "input"
  | "images"
  | "outputSchema"
  | "runTool"
  | "turn"
  | "spend"
>;

/** A discussion ends early: a call did not give its view, or the run hit a limit. */
class DiscussionEnd extends Error {
  readonly result: AgentResult;
  constructor(result: AgentResult) {
    super("the discussion ended early");
    this.result = result;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A reason the discussion takes: one line of 1 to `MAX_REASON_CHARS` characters, trimmed. */
function usableReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length >= 1 &&
    trimmed.length <= MAX_REASON_CHARS &&
    !/[\r\n\u2028\u2029]/.test(trimmed)
    ? trimmed
    : null;
}

/** The view a call's answer gives, trimmed, or null when it does not follow the view schema. */
function viewOf(answer: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(answer);
  } catch {
    return null;
  }
  if (!isObject(value) || Object.keys(value).length !== 1) return null;
  if (typeof value.view !== "string") return null;
  const view = value.view.trim();
  return view.length >= 1 && view.length <= MAX_VIEW_CHARS ? view : null;
}

/**
 * Runs one Council discussion on the task's discussion (D-483): the cast in the task's order,
 * each giving one view, then the chair's answer. The weekly test job runs its Council cases with it
 * too (src/agent-images/eval/week.ts, slice 6e).
 */
export async function runDiscussion(
  loop: DiscussionLoopOptions,
  task: AgentTaskFile,
  secrets: readonly string[],
): Promise<AgentResult> {
  const { discussion, outputSchema } = task;
  if (discussion === undefined || outputSchema === undefined) {
    return errorResult(DISCUSSION_ERRORS.task);
  }
  const { maxPullIns } = discussion;
  const spend = startSpend(loop.clock ?? realClock);
  const record: DiscussionRecord = {
    chair: discussion.chair,
    cast: [...discussion.cast],
    views: [],
    pullIns: [],
    refusedPullIns: [],
  };
  // The same tools, system text and input in every call: the run's one cached prefix.
  const shared = {
    ...loop,
    spend,
    system: discussionSystemText(
      task.instructions,
      task.images !== undefined,
      loop.answerVia ?? "schema",
    ),
    tools: [pullInTool(maxPullIns)],
    input: fencedInput(task.input),
    ...(task.images ? { images: task.images } : {}),
  };
  const clean = (text: string) => redact(text, secrets);

  const state = (): DiscussionState => ({
    chair: record.chair,
    cast: record.cast,
    pullIns: record.pullIns,
    views: record.views,
    pullInsLeft: Math.max(0, maxPullIns - record.pullIns.length),
  });
  const overLimit = () =>
    record.refusedPullIns.some((refused) => refused.why === "limit");
  const inDiscussion = (persona: PersonaId) =>
    persona === record.chair ||
    record.cast.includes(persona) ||
    record.pullIns.some((pullIn) => pullIn.persona === persona);

  function refuse(
    persona: PersonaId,
    by: PersonaId,
    reason: unknown,
    why: PullInRefusal,
  ): ToolOutput {
    if (record.refusedPullIns.length >= MAX_REFUSED_PULL_INS) {
      throw new DiscussionEnd(
        spentResult(spend, "error", "", DISCUSSION_ERRORS.tooManyRefused),
      );
    }
    record.refusedPullIns.push({
      persona,
      by,
      reason: typeof reason === "string" ? recordedReason(clean(reason)) : "",
      why,
    });
    return { content: PULL_IN_REFUSALS[why](maxPullIns), isError: true };
  }

  /** The pull-in tool for one speaker: a refusal, or the pulled-in persona's view as data. */
  const pullInFor =
    (by: PersonaId) =>
    async (name: string, input: unknown): Promise<ToolOutput> => {
      if (name !== PULL_IN_TOOL_NAME) {
        return { content: DISCUSSION_TOOL_ERRORS.noSuchTool, isError: true };
      }
      const { persona, reason } = isObject(input) ? input : {};
      if (!isPersonaId(persona)) {
        return { content: DISCUSSION_TOOL_ERRORS.badPersona, isError: true };
      }
      if (inDiscussion(persona)) return refuse(persona, by, reason, "in_discussion");
      const usable = usableReason(reason);
      if (usable === null) return refuse(persona, by, reason, "bad_reason");
      if (record.pullIns.length >= maxPullIns)
        return refuse(persona, by, reason, "limit");
      const pullIn: PullIn = { persona, by, reason: recordedReason(clean(usable)) };
      record.pullIns.push(pullIn);
      const toldBefore = overLimit();
      const view = await speak(persona, pullIn);
      // The chair's turn went out before this pull-in: it hears of a refusal over the limit here.
      const tell = by === record.chair && !toldBefore && overLimit();
      return {
        content: tell
          ? `${quoteView(view)}\n${overLimitSentence(maxPullIns)}`
          : quoteView(view),
        isError: false,
      };
    };

  /** One persona's view call. A call that ends without a usable view ends the discussion. */
  async function speak(persona: PersonaId, pulledIn?: PullIn): Promise<DiscussionView> {
    const { result } = await runLoop({
      ...shared,
      outputSchema: VIEW_SCHEMA,
      turn: viewTurn(state(), persona, pulledIn),
      runTool: pullInFor(persona),
    });
    if (result.status !== "success") throw new DiscussionEnd(result);
    const text = viewOf(result.finalText);
    if (text === null) {
      throw new DiscussionEnd({
        ...result,
        status: "error",
        errorText: DISCUSSION_ERRORS.badView,
      });
    }
    const view: DiscussionView = {
      persona,
      ...(pulledIn ? { pulledInBy: pulledIn.by } : {}),
      text: clean(text).slice(0, MAX_VIEW_CHARS),
    };
    record.views.push(view);
    return view;
  }

  try {
    for (const persona of record.cast) await speak(persona);
    const { result } = await runLoop({
      ...shared,
      outputSchema,
      turn: chairTurn(state(), maxPullIns, overLimit()),
      runTool: pullInFor(record.chair),
    });
    if (result.status !== "success") return result;
    let structured: unknown;
    try {
      structured = JSON.parse(result.finalText) as unknown;
    } catch {
      return { ...result, status: "error", errorText: DISCUSSION_ERRORS.notJson };
    }
    return { ...result, structured, discussion: record };
  } catch (error) {
    if (error instanceof DiscussionEnd) return error.result;
    throw error;
  }
}
