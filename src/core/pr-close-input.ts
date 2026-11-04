// The close-only run's input and result (D-318, O-98): what the runner hands the OpenCode image's
// wrapper and what the wrapper reports back, each read strictly. No imports, so the image can
// copy this one file (src/agent-images/opencode/Dockerfile); the rest of the close is in
// ./pr-close.ts and src/agent-images/opencode/close.ts.

/** The one comment the wrapper posts before it closes the pull request. No ids, no names. */
export const CLOSE_COMMENT =
  "Closed because this pull request's work item was cancelled: the work is no longer needed (D-308). The branch is left as it is. The bot closed it in plain code, with no model (D-318).";

/** What the close run's input holds: exactly these three fields, as JSON. */
export interface CloseInput {
  /** `owner/name`: the run's own repository. */
  repository: string;
  pullRequest: number;
  /** Always `CLOSE_COMMENT`. */
  comment: string;
}

const CLOSE_INPUT_KEYS = ["repository", "pullRequest", "comment"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The close run's input text. */
export function closeInputText(repository: string, pullRequest: number): string {
  const input: CloseInput = { repository, pullRequest, comment: CLOSE_COMMENT };
  return JSON.stringify(input);
}

/**
 * Reads the close run's input strictly: a JSON object with exactly `repository` (the run's own,
 * `expectedRepository`), `pullRequest` (a whole number above 0) and `comment` (exactly
 * `CLOSE_COMMENT`). Anything else is a problem; nothing is guessed. Problems name the field only.
 */
export function readCloseInput(
  text: string,
  expectedRepository: string,
): CloseInput | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: "the close input is not JSON" };
  }
  if (
    !isObject(value) ||
    Object.keys(value).length !== CLOSE_INPUT_KEYS.length ||
    !CLOSE_INPUT_KEYS.every((key) => Object.hasOwn(value, key))
  ) {
    return {
      problem: "the close input must have repository, pullRequest and comment only",
    };
  }
  if (value.repository !== expectedRepository) {
    return { problem: "the close input's repository is not the run's repository" };
  }
  if (!isNumber(value.pullRequest)) {
    return { problem: "the close input's pullRequest must be a whole number above 0" };
  }
  if (value.comment !== CLOSE_COMMENT) {
    return { problem: "the close input's comment is not the fixed comment" };
  }
  return {
    repository: value.repository,
    pullRequest: value.pullRequest,
    comment: value.comment,
  };
}

/** What the wrapper reports it did with the pull request. */
export const CLOSE_OUTCOMES = [
  "closed",
  "already_closed",
  "already_merged",
  "not_found",
  "refused",
] as const;
export type CloseOutcome = (typeof CLOSE_OUTCOMES)[number];

/** The close run's structured result: exactly `{closeOutcome, pullRequest}`. */
export interface CloseResult {
  closeOutcome: CloseOutcome;
  pullRequest: number;
}

/** The close run's structured result, or null when it is not exactly that shape. */
export function readCloseResult(structured: unknown): CloseResult | null {
  if (!isObject(structured) || Object.keys(structured).length !== 2) return null;
  const { closeOutcome, pullRequest } = structured;
  if (!CLOSE_OUTCOMES.includes(closeOutcome as CloseOutcome) || !isNumber(pullRequest))
    return null;
  return { closeOutcome: closeOutcome as CloseOutcome, pullRequest };
}
