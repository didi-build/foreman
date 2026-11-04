// The run's report, read from the model's final message (N-44, D-235, O-61). The bot file's
// instructions ask the Developer and the Designer to end their final message with exactly one
// fenced block whose info string is `foreman-report`, holding one JSON object:
//
//   ```foreman-report
//   {"pullRequestTitle": "Add the login form", "docsNote": {"impact": "none"}}
//   ```
//
// `docsNote` is the state API's `docs_note` payload (docs/guards.md): `{"impact": "none"}`,
// optionally with a `note`, or `{"impact": "updated", "note": "<what changed in the docs>"}`.
// When the item needs a product decision or a new feature, the model stops instead and the block
// holds the second form (D-237, O-63), with exactly these two fields:
//
//   ```foreman-report
//   {"stopped": "needs_decision", "reason": "The item asks for a new screen the plan does not have."}
//   ```
//
// The first form may also carry `outOfScopeFindings` (D-244, O-65): at most 3 bugs the run
// noticed outside its item, each `{"title": "<one line>", "detail": "<what was seen>"}`, checked
// by ../../core/out-of-scope-findings.ts. The runner submits each as a new idea for the Council;
// they change nothing about the item. The stopped form has no findings: it is exactly two fields.
// Its `stopped` is `needs_decision`, or `already_done` when the item's work is already done on
// the default branch (D-308 (3), O-97): the runner then asks the Council whether the item is
// still needed.
//
// The check is strict: no block, two blocks, text that is not one of those objects, a mix of the
// two forms, an unknown field, or a field of the wrong shape is a problem the run fails on.
// Nothing is guessed or filled in. The rest of the final message, without the block, becomes the
// PR's description; a stopped run opens no PR.
import {
  OUT_OF_SCOPE_FINDINGS,
  readOutOfScopeFindings,
  type OutOfScopeFinding,
} from "../../core/out-of-scope-findings.ts";

export interface DocsNote {
  impact: "updated" | "none";
  note?: string;
}

export interface RunReport {
  pullRequestTitle: string;
  docsNote: DocsNote;
  /** Bugs seen outside the item, trimmed; empty when the block has none (D-244). */
  outOfScopeFindings: OutOfScopeFinding[];
  /** The final message without the block, trimmed. */
  summary: string;
}

/** Why a run stopped: the item needs a decision (D-237), or its work is already done (D-308). */
export type StopKind = "needs_decision" | "already_done";
const STOP_KINDS: readonly string[] = ["needs_decision", "already_done"];

/** The second form: the run stopped because the item needs a decision (D-237). */
export interface StoppedReport {
  stopped: StopKind;
  /** Why, in the model's words, trimmed. */
  reason: string;
}

export const REPORT_INFO_STRING = "foreman-report";
const MAX_TITLE = 200;
const MAX_NOTE = 2000;
/** The runner reads the same bound (NEEDS_DECISION_MAX_REASON in the runtime's result.ts). */
export const MAX_STOP_REASON = 1000;
const REPORT_KEYS = ["pullRequestTitle", "docsNote", OUT_OF_SCOPE_FINDINGS];
const STOPPED_KEYS = ["stopped", "reason"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

/** A block opens on a line of three backticks and the info string, and closes on a line of three backticks. Either may be indented. */
const OPENING = /^[ \t]*```foreman-report[ \t]*$/;
const CLOSING = /^[ \t]*```[ \t]*$/;

/** The report in the final message, or the reason it is unusable. */
export function parseRunReport(
  finalText: string,
): { report: RunReport } | { stopped: StoppedReport } | { problem: string } {
  const lines = finalText.split(/\r?\n/);
  const openings = lines.flatMap((line, i) => (OPENING.test(line) ? [i] : []));
  if (openings.length === 0) return { problem: "there is no foreman-report block" };
  if (openings.length > 1)
    return { problem: "there is more than one foreman-report block" };
  const start = openings[0] as number;
  const end = lines.findIndex((line, i) => i > start && CLOSING.test(line));
  if (end === -1) return { problem: "the foreman-report block is not closed" };

  let value: unknown;
  try {
    value = JSON.parse(lines.slice(start + 1, end).join("\n"));
  } catch {
    return { problem: "the foreman-report block is not JSON" };
  }
  if (isObject(value) && Object.keys(value).some((key) => STOPPED_KEYS.includes(key))) {
    return readStopped(value);
  }
  if (!isObject(value) || !onlyKeys(value, REPORT_KEYS)) {
    return {
      problem:
        "the foreman-report block must be an object with pullRequestTitle, docsNote and an optional outOfScopeFindings only, or with stopped and reason only",
    };
  }
  const title = value.pullRequestTitle;
  if (
    typeof title !== "string" ||
    title.trim() === "" ||
    title.length > MAX_TITLE ||
    /[\r\n]/.test(title)
  ) {
    return {
      problem: `pullRequestTitle must be one line of 1 to ${MAX_TITLE} characters`,
    };
  }
  const note = value.docsNote;
  if (!isObject(note) || !onlyKeys(note, ["impact", "note"])) {
    return {
      problem: "docsNote must be an object with impact and an optional note only",
    };
  }
  if (note.impact !== "updated" && note.impact !== "none") {
    return { problem: "docsNote.impact must be updated or none" };
  }
  if (
    note.note !== undefined &&
    (typeof note.note !== "string" ||
      note.note.trim() === "" ||
      note.note.length > MAX_NOTE)
  ) {
    return { problem: `docsNote.note must be text of 1 to ${MAX_NOTE} characters` };
  }
  if (note.impact === "updated" && note.note === undefined) {
    return { problem: "docsNote.note must say what changed when impact is updated" };
  }
  const found = readOutOfScopeFindings(value[OUT_OF_SCOPE_FINDINGS]);
  if ("problem" in found) return found;
  const summary = [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n").trim();
  return {
    report: {
      pullRequestTitle: title.trim(),
      docsNote: {
        impact: note.impact,
        ...(typeof note.note === "string" ? { note: note.note } : {}),
      },
      outOfScopeFindings: found.findings,
      summary,
    },
  };
}

/** The second form, once a field of it is present: exactly `stopped` and `reason`, nothing mixed. */
function readStopped(
  value: Record<string, unknown>,
): { stopped: StoppedReport } | { problem: string } {
  if (!onlyKeys(value, STOPPED_KEYS) || Object.keys(value).length !== 2) {
    return {
      problem:
        "a stopped foreman-report block must have stopped and reason only, with no pull request fields",
    };
  }
  if (typeof value.stopped !== "string" || !STOP_KINDS.includes(value.stopped)) {
    return { problem: "stopped must be needs_decision or already_done" };
  }
  const reason = value.reason;
  if (
    typeof reason !== "string" ||
    reason.trim() === "" ||
    reason.trim().length > MAX_STOP_REASON
  ) {
    return { problem: `reason must be text of 1 to ${MAX_STOP_REASON} characters` };
  }
  return { stopped: { stopped: value.stopped as StopKind, reason: reason.trim() } };
}

/**
 * Posts the docs note through the state API with the run's token (ADR 0102, `POST /reports`).
 * The API records it by the run's role, for the run's own node only. Its `ref` is the PR's link,
 * the evidence the In development state names, and `commitSha` is the PR's head as the wrapper
 * read it from GitHub, so `docs_updated_or_none` counts the note for that head even though
 * GitHub's `ci_run` rows for it arrive later (D-236).
 */
export async function postDocsNote(options: {
  stateApiUrl: string;
  token: string;
  nodeId: string;
  pullRequestUrl: string;
  /** The PR's head commit, a full 40-hex sha read from GitHub. */
  commitSha: string;
  docsNote: DocsNote;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true } | { ok: false; status: number | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.stateApiUrl}/reports`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        nodeId: options.nodeId,
        kind: "docs_note",
        ref: options.pullRequestUrl,
        commitSha: options.commitSha,
        payload: options.docsNote,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: null };
  }
  // The body is not needed: the evidence id is a database id and is not passed on.
  await response.body?.cancel().catch(() => {});
  return response.status === 201
    ? { ok: true }
    : { ok: false, status: response.status };
}
