// The state API's public listener (D-271). The planning chat runs outside the cluster and reaches
// the runner through one path on the existing Cloudflare Tunnel. The tunnel can route by host name
// and path but not by method, and has no size or rate limit of its own, so the filter lives here,
// on a second port of the state API that only the tunnel connector may reach (its network
// policy, infra/kubernetes/platform.ts):
//
// - it serves `POST /plans` and nothing else; every other method or path answers 404 and never
//   reaches the API's routes (the service kit's own `GET /health` is answered too, but the tunnel
//   forwards only `/plans`);
// - it counts every request in a fixed window, valid token or not, and answers 429 past the limit
//   without reading the body, which also bounds how fast a token can be guessed;
// - it refuses a declared body over the size limit with 413 before reading it; a body sent
//   without a declared length is cut off at the same limit by the API's own reader.
//
// Behind those checks the request goes to the same handler as the internal port, so the planning
// token, the submission's checks and the flow start are exactly those of `POST /plans`
// (./routes.ts). Nothing is logged but the reason for a refusal.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Clock } from "../core/library.ts";
import type { Logger } from "../service-kit/logger.ts";
import { pathOnly, sendJson, type RequestHandler } from "../service-kit/server.ts";
import { MAX_BODY_BYTES, PLANS_PATH } from "./routes.ts";

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
 * is submitted a few times a day at most, so the limit is far above real use and far below what
 * guessing a 32-character random token would need.
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

  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || !PLANS_PATH.test(pathOnly(request.url))) {
      return false;
    }
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
    return api(request, response);
  };
}
