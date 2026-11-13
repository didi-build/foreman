// Why a run's start threw, kept on the step's `start_failed` result (D-384), so a failed start in
// Windmill's run list names its step instead of showing nothing. Until D-384 the error was dropped
// whole, and the rehearsal's first Triage start failed with no way to tell which step broke.
//
// Kept: the error's kind (its `name`) always, and its message only for Foreman's own error
// classes below. Each of those is built from fixed sentences that name a step, a path, a status
// or a Kubernetes reason, and never a token, a key, a database value or GitHub's or Windmill's
// answer (their own files say so). A repo map Job's failure may end with a few plain words from
// the Job, already cut to 200 characters (`RepoMapJobError`). Any other error, a database
// driver's, a network one or a plain `Error`, keeps its kind only: its message could hold a
// value. Nothing here logs.

/** The error classes whose message is kept, by `name`. */
export const SAFE_MESSAGE_ERRORS: readonly string[] = [
  "KubernetesApiError",
  "RepoMapJobError",
  "RepoMapError",
  "GitHubReadError",
  "RunnerAppTokenError",
  "InstallationTokenError",
  "GitHubAppJwtError",
  "RunnerMergeTokenError",
  "WindmillReadError",
  "WindmillNotConfiguredError",
  "NotBuiltError",
];

/** At most this much of a kept message. */
export const START_ERROR_MESSAGE_CHARS = 300;

/** A failed start's error: its kind, and for Foreman's own errors its fixed sentence. */
export interface StartError {
  type: string;
  message?: string;
}

export interface StartFailed {
  outcome: "start_failed";
  error: StartError;
}

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,59}$/;
/** A control character (C0, DEL or C1), turned into a space so a kept message is one line. */
const isControl = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};

const oneLine = (text: string): string =>
  Array.from(text, (char) => (isControl(char) ? " " : char))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();

/** The error's kind and, for the classes above, its message on one line, cut short. */
export function startError(error: unknown): StartError {
  if (!(error instanceof Error)) return { type: typeof error };
  const type = ERROR_NAME.test(error.name) ? error.name : "Error";
  if (!SAFE_MESSAGE_ERRORS.includes(type)) return { type };
  const message = oneLine(error.message).slice(0, START_ERROR_MESSAGE_CHARS);
  return message === "" ? { type } : { type, message };
}

/** The `start_failed` result for a start that threw. */
export function startFailed(error: unknown): StartFailed {
  return { outcome: "start_failed", error: startError(error) };
}
