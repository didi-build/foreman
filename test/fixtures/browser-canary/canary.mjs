// The browser canary (ADR 0119 slice 5b, D-476): proof that a page in the browser host reaches
// nothing but its own site. It starts a canary that records every TCP connection, HTTP request,
// WebSocket upgrade and UDP packet it gets, checks that the canary does record (a connection and a
// packet of its own, then cleared), starts the browser host as a process with the fixture site
// (./site/), and opens the fixture page through the host's tool API. The page tries fetch, an
// image, an iframe, a form, a WebSocket, an EventSource, a beacon, window.open, a service worker,
// WebRTC (STUN over UDP, TURN over TCP), a dedicated worker's fetch and WebSocket, a prefetch, a
// CSS image, and the host's own API five ways. Then the canary must have seen nothing, the host
// must have answered only the canary's own API calls, the page must have made every attempt, the
// blocked requests must name only a scheme and a host, and the site's /api/ must have answered 503.
//
// Node's built-in modules only, so it runs inside the built Messages API image, with a read-only
// root, user 1000 and every capability dropped (scripts/check-agent-container.sh), and in the local
// test with real Chromium (test/browser-canary.test.ts).
//
//   node canary.mjs <browser-host.ts> [listen address]
//
// It prints one JSON line with what it found, and exits 0 only when every check holds.
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { storedZip } from "../zip.mjs";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "site");

/** Every attempt the page makes, in its order. */
export const ATTEMPTS = [
  "fetch",
  "img",
  "iframe",
  "form",
  "websocket",
  "eventsource",
  "beacon",
  "window.open",
  "service worker",
  "webrtc",
  "worker",
  "prefetch",
  "css",
  "host api json",
  "host api text",
  "host api beacon",
  "host api form",
  "host api img",
  "backend",
];

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** The canary: every TCP connection, request, upgrade and UDP packet it gets, counted. */
async function startCanary() {
  const seen = { connections: 0, requests: 0, upgrades: 0, packets: 0 };
  const http = createServer((request, response) => {
    seen.requests += 1;
    response.end("canary");
  });
  http.on("connection", () => {
    seen.connections += 1;
  });
  http.on("upgrade", (_request, socket) => {
    seen.upgrades += 1;
    socket.destroy();
  });
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const udp = createSocket("udp4");
  udp.on("message", () => {
    seen.packets += 1;
  });
  await new Promise((done) => udp.bind(0, "127.0.0.1", done));
  return {
    seen,
    port: http.address().port,
    udpPort: udp.address().port,
    clear() {
      for (const key of Object.keys(seen)) seen[key] = 0;
    },
    close() {
      http.closeAllConnections();
      http.close();
      udp.close();
    },
  };
}

/** Proves the canary records: one connection and one packet of its own. */
async function selfTest(canary) {
  await new Promise((done, fail) => {
    const socket = connect(canary.port, "127.0.0.1", () => {
      socket.end();
      done();
    });
    socket.on("error", fail);
  });
  const client = createSocket("udp4");
  await new Promise((done) =>
    client.send("self-test", canary.udpPort, "127.0.0.1", done),
  );
  client.close();
  for (
    let i = 0;
    i < 50 && (canary.seen.connections < 1 || canary.seen.packets < 1);
    i++
  ) {
    await wait(20);
  }
  const recorded = canary.seen.connections >= 1 && canary.seen.packets >= 1;
  canary.clear();
  return recorded;
}

function siteZip() {
  const entries = readdirSync(SITE)
    .sort()
    .map((name) => ({ name, data: readFileSync(join(SITE, name)), deflate: true }));
  return storedZip(entries);
}

/**
 * Runs the canary against the browser host at `hostEntry`, its tool API on `listen`. Resolves with
 * what it found; `ok` is true only when every check holds.
 */
export async function runCanary({
  hostEntry,
  listen = "127.0.0.1",
  timeoutMs = 60_000,
}) {
  const canary = await startCanary();
  const work = mkdtempSync(join(tmpdir(), "browser-canary-"));
  const siteDir = join(work, "site-memory");
  mkdirSync(siteDir);
  writeFileSync(join(work, "site.zip"), siteZip());
  const env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: work,
    TMPDIR: work,
    FOREMAN_SITE_ZIP: join(work, "site.zip"),
    FOREMAN_SITE_DIR: siteDir,
    FOREMAN_BROWSER_LISTEN: listen,
    FOREMAN_BROWSER_PORT: "0",
    FOREMAN_BROWSER_DEADLINE_SECONDS: String(Math.ceil(timeoutMs / 1000) + 30),
  };
  if (process.env.PLAYWRIGHT_BROWSERS_PATH !== undefined) {
    env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  const found = {
    ok: false,
    canaryRecords: await selfTest(canary),
    canary: canary.seen,
    attempts: [],
    blocked: [],
    backend: null,
    refusals: {},
    hostRequests: 0,
    ownRequests: 0,
    popupsClosed: 0,
    hostExit: null,
    problems: [],
  };
  const host = spawn(process.execPath, [hostEntry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  host.stdout.on("data", (chunk) => (stdout += chunk));
  host.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) => host.on("exit", (code) => done(code)));
  const deadline = Date.now() + timeoutMs;
  /** The tool API's host and port, as a blocked request names it. */
  let apiHost = null;
  try {
    let port = null;
    while (port === null && Date.now() < deadline) {
      const line = stdout.split("\n").find((l) => l.includes('"message":"listening"'));
      if (line) port = JSON.parse(line).port;
      else if (host.exitCode !== null) break;
      else await wait(100);
    }
    if (port === null) throw new Error("the browser host did not start");
    apiHost = `${listen.includes(":") ? `[${listen}]` : listen}:${port}`;
    const base = `http://${apiHost}`;
    const call = async (path, init) => {
      found.ownRequests += 1;
      const response = await fetch(`${base}${path}`, init);
      return { status: response.status, body: await response.json() };
    };
    const post = (path, body) =>
      call(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // The host's own refusals: a GET, a preflight, a form's body, and a page's Origin.
    found.refusals = {
      get: (await call("/read", { method: "GET" })).status,
      options: (await call("/read", { method: "OPTIONS" })).status,
      textPlain: (
        await call("/read", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: '{"view":"text"}',
        })
      ).status,
      origin: (
        await call("/read", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
          body: '{"view":"text"}',
        })
      ).status,
    };

    const path = `/?canary=${canary.port}&udp=${canary.udpPort}&api=${apiHost}`;
    const opened = await post("/open", { path, viewport: "desktop" });
    if (opened.status !== 200) throw new Error(`open answered ${opened.status}`);
    const requests = [...(opened.body.requests ?? [])];
    const consoleLines = [...(opened.body.console ?? [])];
    let title = opened.body.title;
    found.popupsClosed += opened.body.popupsClosed ?? 0;
    while (title !== "canary: done" && Date.now() < deadline) {
      await wait(500);
      const read = await post("/read", { view: "snapshot" });
      title = read.body.title;
      requests.push(...(read.body.requests ?? []));
      consoleLines.push(...(read.body.console ?? []));
      found.popupsClosed += read.body.popupsClosed ?? 0;
    }
    if (title !== "canary: done")
      throw new Error("the page did not finish its attempts");
    // Time for anything late (ICE gathering, a beacon, a prefetch) to arrive.
    await wait(2000);
    for (const view of ["network", "console"]) {
      const read = await post("/read", { view });
      requests.push(...(read.body.requests ?? []));
      consoleLines.push(...(read.body.console ?? []));
      found.popupsClosed += read.body.popupsClosed ?? 0;
    }
    const line = consoleLines.find((text) => text.startsWith("canary attempts: "));
    found.attempts = line ? line.slice("canary attempts: ".length).split(", ") : [];
    found.blocked = requests.filter((r) => r.kind === "blocked");
    found.backend =
      requests.find((r) => r.kind === "status" && r.path === "/api/health")?.status ??
      null;
  } catch (error) {
    found.problems.push(error instanceof Error ? error.message : "the run failed");
  } finally {
    host.kill("SIGTERM");
    found.hostExit = await Promise.race([exited, wait(15_000).then(() => "no exit")]);
    if (found.hostExit === "no exit") host.kill("SIGKILL");
    canary.close();
  }
  found.hostRequests = stdout
    .split("\n")
    .filter((l) => l.includes('"message":"browser request"')).length;

  const blockedHosts = new Set(found.blocked.map((b) => `${b.scheme} ${b.host}`));
  const checks = [
    [found.canaryRecords, "the canary did not record its own connection and packet"],
    [Object.values(found.canary).every((n) => n === 0), "the canary saw traffic"],
    [
      found.hostRequests === found.ownRequests,
      "the host answered a request the canary did not make",
    ],
    [
      ATTEMPTS.every((a) => found.attempts.includes(a)),
      "the page did not make every attempt",
    ],
    [
      blockedHosts.has(`http 127.0.0.1:${canary.port}`),
      "no blocked request to the canary was noted",
    ],
    [
      blockedHosts.has(`ws 127.0.0.1:${canary.port}`),
      "no blocked WebSocket to the canary was noted",
    ],
    [
      blockedHosts.has(`http ${apiHost}`),
      "no blocked request to the host's API was noted",
    ],
    [
      found.blocked.every(
        (b) =>
          Object.keys(b).sort().join(",") === "host,kind,scheme" &&
          !/[/?#]/.test(b.host),
      ),
      "a blocked request was noted with more than its scheme and host",
    ],
    [found.backend === 503, "the site's /api/ did not answer 503"],
    [found.popupsClosed >= 1, "the popup was not closed and reported"],
    [
      found.refusals.get === 405 &&
        found.refusals.options === 405 &&
        found.refusals.textPlain === 415 &&
        found.refusals.origin === 403,
      "the host took a request it must refuse",
    ],
    [found.hostExit === 0, "the browser host did not stop cleanly"],
  ];
  for (const [holds, problem] of checks) if (!holds) found.problems.push(problem);
  found.ok = found.problems.length === 0;
  if (!found.ok && stderr.trim() !== "") found.hostStderr = stderr.slice(-2000);
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [hostEntry, listen] = process.argv.slice(2);
  if (!hostEntry) {
    console.error("usage: canary.mjs <browser-host.ts> [listen address]");
    process.exit(2);
  }
  const found = await runCanary({ hostEntry, listen });
  console.log(JSON.stringify(found));
  process.exit(found.ok ? 0 : 1);
}
