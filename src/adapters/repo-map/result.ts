// How the repo map Job hands its map back (D-275 (2), O-87). The Job prints one result line as
// every agent image does (version 1 of `AgentResult`, src/agent-images/shared/result.ts) and the
// runner reads it from the pod's log, as it reads an agent's. On success its `structured` is
// exactly `{ repoMap: 1, gzipBase64 }`: the map's JSON, gzip'd and base64 encoded, so a large
// repository's map still fits the bounded log read. Both sides check the map against the core's
// bounds (`checkRepoMap`), so a map the runner would refuse fails in the Job with its reason.
//
// The runner treats everything here as untrusted data: the encoded text is bounded, decoded
// strictly, unpacked with a bound, parsed and checked field by field before it is used.
import { gunzipSync, gzipSync } from "node:zlib";

import { checkRepoMap, RepoMapError, type RepoMap } from "../../core/repo-map.ts";

/** The most characters of encoded map a result may carry. */
export const MAX_ENCODED_MAP_CHARS = 3_000_000;
/** The most bytes the map's JSON may unpack to. */
export const MAX_MAP_JSON_BYTES = 32 * 1024 * 1024;
/**
 * The most bytes of the Job's log the runner reads: the result line with room for its frame and
 * the few lines before it. Below the Kubernetes client's 4 MiB response bound.
 */
export const RESULT_LOG_BYTES = 3 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface RepoMapResult {
  repoMap: 1;
  gzipBase64: string;
}

/** The map as the Job's `structured` result, after the same check the runner makes. */
export function encodeRepoMapResult(map: RepoMap): RepoMapResult {
  checkRepoMap(map, map.commitSha);
  const json = JSON.stringify(map);
  if (Buffer.byteLength(json, "utf8") > MAX_MAP_JSON_BYTES) {
    throw new RepoMapError(`the repo map is larger than ${MAX_MAP_JSON_BYTES} bytes`);
  }
  const gzipBase64 = gzipSync(json).toString("base64");
  if (gzipBase64.length > MAX_ENCODED_MAP_CHARS) {
    throw new RepoMapError(
      `the repo map is larger than ${MAX_ENCODED_MAP_CHARS} characters encoded`,
    );
  }
  return { repoMap: 1, gzipBase64 };
}

/**
 * The map in a Job's `structured` result, checked for `commitSha`. Throws `RepoMapError` naming
 * the problem, never a value.
 */
export function decodeRepoMapResult(structured: unknown, commitSha: string): RepoMap {
  if (
    typeof structured !== "object" ||
    structured === null ||
    Array.isArray(structured) ||
    Object.keys(structured).length !== 2
  ) {
    throw new RepoMapError("the result is not exactly repoMap and gzipBase64");
  }
  const { repoMap, gzipBase64 } = structured as Record<string, unknown>;
  if (repoMap !== 1 || typeof gzipBase64 !== "string") {
    throw new RepoMapError("the result is not exactly repoMap and gzipBase64");
  }
  if (gzipBase64.length > MAX_ENCODED_MAP_CHARS || !BASE64.test(gzipBase64)) {
    throw new RepoMapError("the encoded map is not base64 within its bound");
  }
  let json: string;
  try {
    json = gunzipSync(Buffer.from(gzipBase64, "base64"), {
      maxOutputLength: MAX_MAP_JSON_BYTES,
    }).toString("utf8");
  } catch {
    throw new RepoMapError(
      `the encoded map is not gzip, or unpacks to more than ${MAX_MAP_JSON_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new RepoMapError("the encoded map is not JSON");
  }
  return checkRepoMap(value, commitSha);
}
