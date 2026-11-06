// The state API's public listener (D-271, amended by D-282). The planning chat runs outside the
// cluster and reaches the runner through its own routes on the existing Cloudflare Tunnel. The tunnel can route by host name
// and path but not by method, and has no size or rate limit of its own, so the filter lives here,
// on a second port of the state API that only the tunnel connector may reach (its network
// policy, infra/kubernetes/platform.ts):
//
// - it serves the planning chat's routes and nothing else, under the public host name's `/api`
//   prefix (D-343): `POST /api/plans` and the three reads
//   `GET /api/planning/projects/<slug>/{submissions,feedback,accepted}` (D-282). Every other
//   method or path answers 404 and never reaches the API's routes, the same routes without the
//   prefix included (the service kit's own `GET /health` is answered too, but the tunnel forwards
//   only the planning chat's paths);
// - the tunnel cannot rewrite a path, so this listener takes the prefix off: the API's own routes
//   keep their names (`POST /plans`, ./routes.ts) and the internal port is unchanged (O-106);
// - it counts every request in a fixed window, valid token or not, and answers 429 past the limit
//   without reading the body, which also bounds how fast a token can be guessed;
// - it refuses a declared body over the size limit with 413 before reading it; a body sent
//   without a declared length is cut off at the same limit by the API's own reader.
//
// Behind those checks the request goes to the same handler as the internal port, so the planning
// token, the submission's checks, the flow start and the reads' project scope are exactly those of
// the internal routes (./routes.ts). Nothing is logged but the reason for a refusal.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Clock } from "../core/library.ts";
import type { Logger } from "../service-kit/logger.ts";
import { pathOnly, sendJson, type RequestHandler } from "../service-kit/server.ts";
import { MAX_BODY_BYTES, PLANNING_READ_PATH, PLANS_PATH } from "./routes.ts";

/** The public host name's prefix for every machine-facing path (D-343). */
export const PUBLIC_API_PREFIX = "/api";

/** The public listener's limits (D-271, O-83). */
export interface PublicLimits {
  /** The largest request body, in bytes. */
  maxBodyBytes: number;
  /** Requests allowed per window, across all callers. */
  requestsPerWindow: number;
  windowSeconds: number;
}

/**
 * The defaults: the API's own 64 KiB body cap, and 20 requests a minute across all callers. A plan
 * is submitted a few times a day at most and the chat reads a handful of times around each, so the
 * limit is far above real use and far below what guessing a 32-character random token would need.
 */
export const PUBLIC_LIMITS: PublicLimits = {
  maxBodyBytes: MAX_BODY_BYTES,
  requestsPerWindow: 20,
  windowSeconds: 60,
};

export interface PublicHandlerOptions {
  /** The state API's own handler (./routes.ts). */
  api: RequestHandler;
  clock: Clock;
  logger: Logger;
  limits?: PublicLimits;
}

export function createPublicHandler({
  api,
  clock,
  logger,
  limits = PUBLIC_LIMITS,
}: PublicHandlerOptions): RequestHandler {
  let windowStart = 0;
  let count = 0;

  /** Counts this request; returns the seconds to wait when the window is full. */
  function overLimit(): number | null {
    const now = clock.now().getTime();
    const windowMs = limits.windowSeconds * 1000;
    if (now - windowStart >= windowMs || now < windowStart) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    if (count <= limits.requestsPerWindow) return null;
    return Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
  }

  /**
   * The API route a public request names, or null: only the planning chat's routes (D-282),
   * `POST /api/plans` and the three planning reads, each under the `/api` prefix (D-343).
   */
  function planningRoute(request: IncomingMessage): string | null {
    const path = pathOnly(request.url);
    if (!path.startsWith(`${PUBLIC_API_PREFIX}/`)) return null;
    const route = path.slice(PUBLIC_API_PREFIX.length);
    if (request.method === "POST") return PLANS_PATH.test(route) ? route : null;
    if (request.method === "GET") return PLANNING_READ_PATH.test(route) ? route : null;
    return null;
  }

  return async (request: IncomingMessage, response: ServerResponse) => {
    const route = planningRoute(request);
    if (route === null) return false;
    const wait = overLimit();
    if (wait !== null) {
      logger.warn("public request refused", { reason: "rate_limited" });
      response.setHeader("retry-after", String(wait));
      sendJson(response, 429, { error: "too many requests" });
      return true;
    }
    const declared = Number(request.headers["content-length"] ?? "0");
    if (!Number.isFinite(declared) || declared > limits.maxBodyBytes) {
      logger.warn("public request refused", { reason: "too_large" });
      response.setHeader("connection", "close");
      sendJson(response, 413, { error: "request body is too large" });
      return true;
    }
    // The API's own route, without the prefix; the query string is not passed on, and no route
    // reads one.
    request.url = route;
    return api(request, response);
  };
}
