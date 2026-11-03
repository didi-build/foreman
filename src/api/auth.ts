// Per-run agent authentication (ADR 0102). A token is an opaque random value; only its SHA-256
// hash is stored, linked to one run, one role and one project. Ending the run revokes it.
//
// The planning chat has one identity of its own (D-266): a long random token that Didi creates at
// first hosting and keeps only in the chat's settings. The state API holds only its SHA-256, read
// from the secret path `platform/state-api/planning-token-sha256`; with no hash set, no planning
// token is accepted. A planning caller is not a run and has no role: the API lets it call
// `POST /plans` and the planning reads under `/planning/projects/<slug>/` and nothing else
// (src/api/routes.ts).
import { timingSafeEqual } from "node:crypto";

import { hashRunToken } from "../core/run-tokens.ts";
import type { AgentRole, Run, StoreOps } from "../core/store.ts";

export interface Caller {
  role: AgentRole;
  projectId: string;
  run: Run;
}

/** The same hash the runner stores at dispatch (src/core/run-tokens.ts). */
export const hashToken = hashRunToken;

/** Tokens are long random values; anything outside this range cannot be one. */
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

/** The secret path of the planning chat's token hash (D-266). */
export const PLANNING_TOKEN_SHA256_PATH = "platform/state-api/planning-token-sha256";

/** A SHA-256 in hex, as the planning token's setting holds it. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The bearer token in an `Authorization` header, when it has a token's shape. */
function bearer(header: string | undefined): string | null {
  const token = /^Bearer (\S+)$/.exec(header ?? "")?.[1];
  return token && TOKEN.test(token) ? token : null;
}

/**
 * Whether the header carries the planning chat's token: its SHA-256 equals the configured hash,
 * compared in constant time. False when no hash is configured.
 */
export function isPlanningCaller(
  header: string | undefined,
  planningTokenSha256: string | null,
): boolean {
  if (planningTokenSha256 === null || !SHA256_HEX.test(planningTokenSha256))
    return false;
  const token = bearer(header);
  if (!token) return false;
  return timingSafeEqual(
    Buffer.from(hashToken(token), "hex"),
    Buffer.from(planningTokenSha256, "hex"),
  );
}

/**
 * The caller behind an `Authorization: Bearer` header, or null. Null covers a missing or
 * malformed header, an unknown token, an expired or revoked one, and a run that has ended, so a
 * caller learns nothing about which check failed.
 */
export async function authenticate(
  store: Pick<StoreOps, "getRunToken" | "getRun">,
  header: string | undefined,
  now: Date,
): Promise<Caller | null> {
  const token = bearer(header);
  if (!token) return null;
  const record = await store.getRunToken(hashToken(token));
  if (!record || record.revokedAt !== null || record.expiresAt <= now) return null;
  const run = await store.getRun(record.runId);
  if (!run || run.endedAt !== null || run.projectId !== record.projectId) return null;
  return { role: record.role, projectId: record.projectId, run };
}
