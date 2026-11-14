// Why an agent run that started did not succeed, kept beside its fixed reason code (D-385), so a
// failed run in Windmill's run list names its cause instead of only `fail`. Until D-385 the agent's
// error was dropped whole, and the rehearsal's first Triage runs failed with 0 turns and no way
// to tell why.
//
// Kept, as D-384 keeps for a start that threw: the model provider's HTTP status and error type
// when it answered (its `type`, such as `authentication_error`, never its message), and the
// agent's error sentence only when it is one of the agent images' own fixed sentences below,
// which name a step, a status, a setting or a limit and never a value. A sentence whose fixed
// start is followed by words from the model keeps its fixed start only. Any other error text,
// the model's or a tool's words, or a message a library made, is not kept. Nothing here logs,
// and nothing is stored: the runner's result shows it (flows/lib/runs.ts).
import { CEILING_MESSAGE, REJECTED_CEILING_MESSAGE } from "../../egress-proxy/proxy.ts";

/** A failed run's cause, as far as it can be kept (D-385). Every field may be missing. */
export interface RunFailure {
  /** The model provider's HTTP status, when the run ended on its answer. */
  providerStatus?: number;
  /** The provider's error type, such as `authentication_error`. */
  providerType?: string;
  /** The agent's error, only when it is one of the images' fixed sentences. */
  error?: string;
}

/**
 * The agent images' fixed error sentences, whole (src/agent-images/claude-api/loop.ts and
 * image.ts, claude-code/parse.ts and image.ts, opencode/result.ts and image.ts, the shared
 * settings reader in src/service-kit/config.ts, and the egress proxy's ceilings).
 */
export const FIXED_RUN_ERRORS: readonly RegExp[] = [
  /^the run reached its (turn|dollar) limit$/,
  /^the model endpoint could not be reached$/,
  /^the model provider answered \d{3}$/,
  /^the model's reply reached the output token limit$/,
  /^the model declined the request$/,
  /^the model stopped for an unknown reason$/,
  /^the answer is not JSON$/,
  /^the state API could not be reached to record the verdict$/,
  /^the state API refused the verdict with status \d{3}$/,
  /^a visual comparison task needs its answer schema$/,
  /^the run failed( before (Claude Code|OpenCode) started)?$/,
  /^Claude Code exited with (a signal|code \d{1,3}) and printed no result$/,
  /^Claude Code ended with [a-z_]{1,40}$/,
  /^the run reached its (dollar cap|turn limit); OpenCode was stopped$/,
  /^OpenCode was stopped before it finished$/,
  /^OpenCode exited with (a signal|code \d{1,3})( before any model step)?$/,
  /^OpenCode printed no model step$/,
  // The settings reader names each setting and its fixed problem, never the value it read.
  /^Invalid configuration: [A-Z][A-Z0-9_]{1,63} [a-z][a-z0-9 ,.()/'-]{0,119}(; [A-Z][A-Z0-9_]{1,63} [a-z][a-z0-9 ,.()/'-]{0,119}){0,9}$/,
  new RegExp(`^${CEILING_MESSAGE.replace(/[.]/g, "\\.")}$`),
  new RegExp(`^${REJECTED_CEILING_MESSAGE.replace(/[.]/g, "\\.")}$`),
];

/**
 * Fixed starts followed by `: ` and words from the model or the state API's check, which are not
 * kept (claude-api's verdict check, opencode/finish.ts `FINISH_FAILURES`).
 */
export const FIXED_RUN_ERROR_STARTS: readonly string[] = [
  "the verdict is unusable",
  "the final message has no usable report",
  "the run's pull request was not opened",
  "the docs note was not recorded",
];

const PROVIDER_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

/** The agent's error when it is one of the fixed sentences, or its fixed start; else nothing. */
export function fixedRunError(errorText: string): string | undefined {
  const text = errorText.trim();
  if (FIXED_RUN_ERRORS.some((pattern) => pattern.test(text))) return text;
  return FIXED_RUN_ERROR_STARTS.find(
    (start) => text === start || text.startsWith(`${start}: `),
  );
}

/** What a failed run's result keeps of its cause (D-385). */
export function runFailure(
  errorText: string,
  provider: { status: number | null; type: string } | null,
): RunFailure {
  const failure: RunFailure = {};
  if (
    provider?.status != null &&
    Number.isInteger(provider.status) &&
    provider.status >= 100 &&
    provider.status <= 599
  ) {
    failure.providerStatus = provider.status;
  }
  if (provider && PROVIDER_TYPE.test(provider.type))
    failure.providerType = provider.type;
  const error = fixedRunError(errorText);
  if (error !== undefined) failure.error = error;
  return failure;
}
