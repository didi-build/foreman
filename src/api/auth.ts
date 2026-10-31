// Per-run agent authentication (ADR 0102). A token is an opaque random value; only its SHA-256
// hash is stored, linked to one run, one role and one project. Ending the run revokes it.
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
  const match = /^Bearer (\S+)$/.exec(header ?? "");
  const token = match?.[1];
  if (!token || !TOKEN.test(token)) return null;
  const record = await store.getRunToken(hashToken(token));
  if (!record || record.revokedAt !== null || record.expiresAt <= now) return null;
  const run = await store.getRun(record.runId);
  if (!run || run.endedAt !== null || run.projectId !== record.projectId) return null;
  return { role: record.role, projectId: record.projectId, run };
}
