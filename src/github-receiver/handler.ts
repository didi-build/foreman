// The webhook endpoint (ADR 0113 sections 2 and 8). Order matters: cap the raw body, check the
// signature over those exact bytes, and only then parse. A request that fails the signature is
// answered 401 with nothing parsed or stored. The receiver reads nothing from GitHub and holds no
// GitHub token (D-381, O-128): it records the delivery as its signed payload alone decides it
// (`receiveDelivery`, src/core/github-ingest.ts), and a delivery that needs GitHub is then handed
// to the ingest flow (./ingest-starts.ts), which reads GitHub with the runner's own client and
// records the evidence. Then, apart from CI's path on a PR head, the removal of
// `BOOTSTRAP_TOKEN`'s access when Bootstrap's restarted run ended (./bootstrap-starts.ts, O-114)
// and the staging deploy of CI's build on main (./staging-starts.ts, O-116), each from the signed
// payload and the two switches, before the answer, which a failed start never changes.
import type { IncomingMessage } from "node:http";

import type { GitHubAdapter } from "../adapters/github/adapter.ts";
import {
  DELIVERY_ID,
  receiveDelivery,
  type ReceiveDeps,
} from "../core/github-ingest.ts";
import type { Logger } from "../service-kit/logger.ts";
import { pathOnly, sendJson, type RequestHandler } from "../service-kit/server.ts";
import type { BootstrapStarts } from "./bootstrap-starts.ts";
import type { IngestStarts } from "./ingest-starts.ts";
import type { StagingStarts } from "./staging-starts.ts";

/**
 * The one webhook path. Every machine-facing path on the cluster's public host name is under
 * `/api` (D-343); any other path, the old `/github/webhook` included, answers 404.
 */
export const WEBHOOK_PATH = "/api/github/webhook";

/** The events ingestion reads are far smaller; anything larger is refused unread. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** GitHub's event names. A name or a delivery id outside its pattern is not logged or stored. */
const EVENT_NAME = /^[a-z_]{1,100}$/;

export interface ReceiverOptions {
  /** Only the webhook signature check: the receiver reads nothing from GitHub (D-381). */
  github: Pick<GitHubAdapter, "verifyWebhookSignature">;
  /** The store the deliveries are recorded in, and the clock that dates them. */
  ingest: ReceiveDeps;
  /** Hands a recorded delivery that needs GitHub to the ingest flow (O-128). Never throws. */
  ingestStarts: IngestStarts;
  /** Starts the removal of `BOOTSTRAP_TOKEN`'s access after Bootstrap's restart (O-114). Never throws. */
  bootstrapStarts?: BootstrapStarts;
  /** Starts the staging deploy of CI's build on main (O-116). Never throws. */
  stagingStarts?: StagingStarts;
  logger: Logger;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** The raw body, or null once it passes the cap (the rest is left unread). */
async function readRaw(request: IncomingMessage): Promise<Buffer | null> {
  if (Number(header(request, "content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function parse(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    // Signed but not JSON: ingestion records the delivery as rejected.
    return undefined;
  }
}

export function createReceiverHandler(options: ReceiverOptions): RequestHandler {
  const { github, logger } = options;

  return async (request, response) => {
    if (request.method !== "POST" || pathOnly(request.url) !== WEBHOOK_PATH)
      return false;
    const given = header(request, "x-github-delivery");
    const deliveryId = given !== undefined && DELIVERY_ID.test(given) ? given : null;

    const raw = await readRaw(request);
    if (raw === null) {
      logger.warn("delivery refused", { deliveryId, outcome: "too_large" });
      response.setHeader("connection", "close");
      sendJson(response, 413, { error: "request body is too large" });
      return true;
    }
    if (!github.verifyWebhookSignature(raw, header(request, "x-hub-signature-256"))) {
      logger.warn("delivery refused", { deliveryId, outcome: "bad_signature" });
      sendJson(response, 401, { error: "invalid signature" });
      return true;
    }
    const event = header(request, "x-github-event");
    if (deliveryId === null || event === undefined || !EVENT_NAME.test(event)) {
      sendJson(response, 400, { error: "missing delivery id or event type" });
      return true;
    }

    const result = await receiveDelivery(options.ingest, {
      id: deliveryId,
      event,
      payload: parse(raw),
    });
    logger.info("delivery", {
      deliveryId,
      event,
      repo: result.repo,
      pr: result.pr,
      outcome: result.outcome,
    });
    await options.ingestStarts(deliveryId, result);
    const delivery = { event, payload: parse(raw) };
    await options.bootstrapStarts?.(deliveryId, delivery, result);
    await options.stagingStarts?.(deliveryId, delivery, result);
    sendJson(response, result.outcome === "rejected" ? 400 : 202, {
      outcome: result.outcome,
    });
    return true;
  };
}
