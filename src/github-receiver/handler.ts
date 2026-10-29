// The webhook endpoint (ADR 0113 sections 2 and 8). Order matters: cap the raw body, check the
// signature over those exact bytes, and only then parse. A request that fails the signature is
// answered 401 with nothing parsed or stored.
import type { IncomingMessage } from "node:http";

import type { GitHubAdapter } from "../adapters/github/adapter.ts";
import { ingestDelivery, type IngestDeps } from "../core/github-ingest.ts";
import type { Logger } from "../service-kit/logger.ts";
import { pathOnly, sendJson, type RequestHandler } from "../service-kit/server.ts";

export const WEBHOOK_PATH = "/github/webhook";

/** The events ingestion reads are far smaller; anything larger is refused unread. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** GitHub's delivery ids and event names. Anything else is not logged or stored. */
const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/;
const EVENT_NAME = /^[a-z_]{1,100}$/;

export interface ReceiverOptions {
  github: GitHubAdapter;
  ingest: Omit<IngestDeps, "github">;
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
  const deps: IngestDeps = { ...options.ingest, github };

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

    const result = await ingestDelivery(deps, {
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
    sendJson(response, result.outcome === "rejected" ? 400 : 202, {
      outcome: result.outcome,
    });
    return true;
  };
}
