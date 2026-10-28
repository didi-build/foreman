// An HTTP server with the health endpoint and clean shutdown every service needs (ADR 0111).
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "./logger.ts";

/** Handle a request and return true, or return false to let the server answer 404. */
export type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => boolean | Promise<boolean>;

export interface ServiceOptions {
  name: string;
  port: number;
  logger: Logger;
  handle?: RequestHandler;
  /** In-flight requests get this long to finish after a stop is requested. */
  shutdownTimeoutMs?: number;
}

export interface RunningService {
  port: number;
  stop(): Promise<void>;
}

/** The path of a request URL without its query string or fragment. */
export function pathOnly(url: string | undefined): string {
  return new URL(url ?? "/", "http://localhost").pathname;
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startService(options: ServiceOptions): Promise<RunningService> {
  const { name, logger, handle, shutdownTimeoutMs = 10_000 } = options;
  const server: Server = createServer((request, response) => {
    void respond(request, response);
  });

  async function respond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { status: "ok", service: name });
        return;
      }
      if (handle && (await handle(request, response))) return;
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      // Path only (a query string can carry tokens) and the error's type, not its message,
      // which can echo secrets or personal data (ADR 0102).
      logger.error("request failed", {
        path: pathOnly(request.url),
        errorType: error instanceof Error ? error.name : typeof error,
      });
      if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => resolve());
  });

  let stopping: Promise<void> | undefined;
  return {
    port: (server.address() as AddressInfo).port,
    stop: () =>
      (stopping ??= new Promise<void>((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs);
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      })),
  };
}

/** Stop the service and exit 0 on SIGTERM or SIGINT, as an orchestrator expects. */
export function exitOnSignals(service: RunningService, logger: Logger): void {
  const shutDown = (signal: NodeJS.Signals): void => {
    logger.info("shutting down", { signal });
    void service.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutDown);
  process.once("SIGINT", shutDown);
}
