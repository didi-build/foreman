// Per-run state API tokens (ADR 0102, ADR 0106 section 5). The runner mints a token for each run
// outside the core, since the core never generates random values (D-162), and the core stores
// only its SHA-256 hash, linked to the run, in the transaction that admits the run. Ending the run
// revokes it. The API checks a caller's token the same way (src/api/auth.ts).
import { createHash } from "node:crypto";

/** The hex SHA-256 of a token: the only form of it the store ever holds. */
export const hashRunToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const RUN_TOKEN_HASH = /^[0-9a-f]{64}$/;

/**
 * How much longer a token lives than its run's minute limit (ADR 0102 point 1: the minute budget
 * plus a margin). It covers the time before the agent pod starts and QA's fetch step, which runs
 * before the review's own deadline. The run's end revokes the token sooner.
 */
export const RUN_TOKEN_MARGIN_MINUTES = 15;

/** When a run's token expires: its start plus its minute limit plus the margin. */
export function runTokenExpiry(startedAt: Date, maxMinutes: number): Date {
  return new Date(
    startedAt.getTime() + (maxMinutes + RUN_TOKEN_MARGIN_MINUTES) * 60_000,
  );
}
