// The browser host (ADR 0119 slice 5b, D-476): the command of QA's browser pod, from the Messages
// API image. The pod holds no token, model key, task file or workspace, has no proxy settings and
// no network egress at all; only the run's agent pod reaches its tool API (ADR 0106 sections 2, 4
// and 5). In order, it:
//
// 1. reads its settings, every problem named at once and no value ever shown;
// 2. unpacks the site's zip from the run's site Secret into its in-memory folder, read-only
//    (./browser-site.ts), and serves it on 127.0.0.1 only, the backend answering 503 (D-478);
// 3. launches Chromium for that site alone (./browser-session.ts);
// 4. serves the tool API on the pod's own IP address and port (./browser-api.ts);
// 5. stops at its deadline, or on SIGTERM or SIGINT, closing Chromium and both servers, and exits
//    0. A start that fails, or a Chromium that goes away, exits 1.
//
// It logs one JSON object per line: its start and stop, and for each request the endpoint, the
// status, the size and the time (./browser-api.ts). Never a path, a ref, a value or page content.
//
// Settings:
//   FOREMAN_SITE_ZIP                   the site's zip, from the site Secret (an absolute path)
//   FOREMAN_SITE_DIR                   the empty in-memory folder to unpack it into (absolute)
//   FOREMAN_BROWSER_LISTEN             the IP address the tool API listens on: the pod's own
//   FOREMAN_BROWSER_PORT               its port (0 picks a free one, for tests)
//   FOREMAN_BROWSER_DEADLINE_SECONDS   how long the host runs before it stops by itself
import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { ConfigError, readConfig, type Setting } from "../../service-kit/config.ts";
import { createLogger, type Logger } from "../../service-kit/logger.ts";
import { browserApi } from "./browser-api.ts";
import { launchBrowserSession, type BrowserSession } from "./browser-session.ts";
import {
  MAX_SITE_ZIP_FILE_BYTES,
  SiteError,
  startSite,
  unpackSite,
} from "./browser-site.ts";

const absolutePath = (env: string): Setting<string> => ({
  env,
  parse: (raw) => {
    if (!isAbsolute(raw) || raw.includes("\0"))
      throw new Error("is not an absolute path");
    return raw;
  },
});

const listenAddress = (env: string): Setting<string> => ({
  env,
  parse: (raw) => {
    if (isIP(raw) === 0) throw new Error("is not an IP address");
    if (raw === "0.0.0.0" || raw === "::") {
      throw new Error("must be one address, not every address");
    }
    return raw;
  },
});

const portOrZero = (env: string): Setting<number> => ({
  env,
  parse: (raw) => {
    const value = Number(raw);
    if (!/^\d{1,5}$/.test(raw) || value > 65535) {
      throw new Error("is not a port number from 0 to 65535");
    }
    return value;
  },
});

const seconds = (env: string): Setting<number> => ({
  env,
  parse: (raw) => {
    const value = Number(raw);
    if (!/^\d{1,9}$/.test(raw) || value < 1) {
      throw new Error("is not a whole number of seconds from 1");
    }
    return value;
  },
});

export const BROWSER_HOST_SETTINGS = {
  siteZip: absolutePath("FOREMAN_SITE_ZIP"),
  siteDir: absolutePath("FOREMAN_SITE_DIR"),
  listen: listenAddress("FOREMAN_BROWSER_LISTEN"),
  port: portOrZero("FOREMAN_BROWSER_PORT"),
  deadlineSeconds: seconds("FOREMAN_BROWSER_DEADLINE_SECONDS"),
};

export type BrowserHostSettings = {
  siteZip: string;
  siteDir: string;
  listen: string;
  port: number;
  deadlineSeconds: number;
};

/** A start step that failed, with a fixed reason. */
export type StartStep =
  "site_zip" | "site" | "site_server" | "closed_port" | "browser" | "api";
export class StartError extends Error {
  readonly step: StartStep;
  constructor(step: StartStep, message: string) {
    super(message);
    this.name = "StartError";
    this.step = step;
  }
}

export const START_REFUSALS = {
  siteZip: `the site zip could not be read, or is larger than ${MAX_SITE_ZIP_FILE_BYTES} bytes`,
  siteServer: "the site's server did not start on 127.0.0.1",
  closedPort: "no closed port on 127.0.0.1 was found for Chromium's proxy",
  browser: "Chromium did not start",
  api: "the tool API could not listen on its address and port",
} as const;

export interface BrowserHost {
  /** The tool API's address, `http://<listen>:<port>`. */
  apiUrl: string;
  port: number;
  /** Stops Chromium and both servers. Safe to call twice. */
  close(): Promise<void>;
  /** Called once if Chromium goes away while the host is not closing. */
  onBrowserGone(listener: () => void): void;
}

const listening = (server: Server, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

const closed = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

/** A port on 127.0.0.1 that nothing listens on: bound once to find it, then let go. */
async function closedLoopbackPort(): Promise<number> {
  const probe = createServer();
  await listening(probe, 0, "127.0.0.1");
  const { port } = probe.address() as AddressInfo;
  await closed(probe);
  return port;
}

function readSiteZip(path: string): Uint8Array {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_SITE_ZIP_FILE_BYTES) throw new Error("size");
    return readFileSync(path);
  } catch {
    throw new StartError("site_zip", START_REFUSALS.siteZip);
  }
}

/** Starts the site, Chromium and the tool API. Anything started is stopped again on a failure. */
export async function startBrowserHost(
  settings: BrowserHostSettings,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserHost> {
  const zip = readSiteZip(settings.siteZip);
  let folder: string;
  try {
    folder = unpackSite(zip, settings.siteDir);
  } catch (error) {
    throw new StartError(
      "site",
      error instanceof SiteError ? error.message : "the site could not be unpacked",
    );
  }

  const stops: (() => Promise<void>)[] = [];
  const stopAll = async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => {});
  };
  try {
    const site = await startSite(folder).catch(() => {
      throw new StartError("site_server", START_REFUSALS.siteServer);
    });
    stops.push(() => closed(site.server));
    const closedPort = await closedLoopbackPort().catch(() => {
      throw new StartError("closed_port", START_REFUSALS.closedPort);
    });
    const session: BrowserSession = await launchBrowserSession({
      siteOrigin: site.origin,
      closedPort,
      env,
    }).catch(() => {
      throw new StartError("browser", START_REFUSALS.browser);
    });
    stops.push(() => session.close());
    const api = createServer(browserApi(session, logger));
    await listening(api, settings.port, settings.listen).catch(() => {
      throw new StartError("api", START_REFUSALS.api);
    });
    stops.push(() => closed(api));
    const { port } = api.address() as AddressInfo;
    const host = settings.listen.includes(":")
      ? `[${settings.listen}]`
      : settings.listen;
    return {
      apiUrl: `http://${host}:${port}`,
      port,
      close: stopAll,
      onBrowserGone: (listener) => session.onGone(listener),
    };
  } catch (error) {
    await stopAll();
    throw error;
  }
}

/**
 * The host's whole life: settings, start, then wait for the deadline or a signal. Resolves with
 * the exit code.
 */
export async function runBrowserHost(
  env: NodeJS.ProcessEnv,
  logger: Logger = createLogger("browser-host"),
  signals: NodeJS.EventEmitter = process,
): Promise<number> {
  let settings: BrowserHostSettings;
  try {
    settings = readConfig(BROWSER_HOST_SETTINGS, env);
  } catch (error) {
    logger.error("browser host settings", {
      problems: error instanceof ConfigError ? error.problems : ["settings unreadable"],
    });
    return 1;
  }
  let host: BrowserHost;
  try {
    host = await startBrowserHost(settings, logger, env);
  } catch (error) {
    logger.error("browser host did not start", {
      step: error instanceof StartError ? error.step : "unknown",
      reason: error instanceof StartError ? error.message : "unexpected error",
    });
    return 1;
  }
  logger.info("listening", {
    port: host.port,
    deadlineSeconds: settings.deadlineSeconds,
  });

  return new Promise((resolve) => {
    let stopping = false;
    const stop = (reason: "deadline" | "signal" | "browser_gone", code: number) => {
      if (stopping) return;
      stopping = true;
      clearTimeout(deadline);
      signals.off("SIGTERM", onSignal);
      signals.off("SIGINT", onSignal);
      void host.close().then(() => {
        logger.info("stopped", { reason });
        resolve(code);
      });
    };
    const onSignal = () => stop("signal", 0);
    const deadline = setTimeout(
      () => stop("deadline", 0),
      settings.deadlineSeconds * 1000,
    );
    signals.once("SIGTERM", onSignal);
    signals.once("SIGINT", onSignal);
    host.onBrowserGone(() => stop("browser_gone", 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runBrowserHost(process.env));
}
