import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { readConfig } from "../../service-kit/config.ts";
import { createLogger } from "../../service-kit/logger.ts";
import { headlessShellInstalled } from "../../../test/headless-shell.ts";
import { storedZip } from "../../../test/zip-fixture.ts";
import {
  BROWSER_API_ERRORS,
  MAX_BODY_BYTES,
  browserApi,
  isJsonType,
  isSitePath,
  parseAct,
  parseOpen,
  parseRead,
} from "./browser-api.ts";
import {
  BROWSER_HOST_SETTINGS,
  runBrowserHost,
  START_REFUSALS,
} from "./browser-host.ts";
import {
  ACTION_ERRORS,
  ActionError,
  BROWSER_LIMITS,
  KEYS,
  NoPageError,
  chromiumLaunchOptions,
  type BrowserSession,
  type PageAnswer,
} from "./browser-session.ts";
import {
  BACKEND_OFF_TEXT,
  SITE_REFUSALS,
  isBackendPath,
  startSite,
  unpackSite,
} from "./browser-site.ts";

// The browser host (ADR 0119 slice 5b, D-476, D-478). Unit: the tool API's input rules and
// refusals against a fake session, the site's unpacking and server, the settings and Chromium's
// launch options; no browser. Broader: the host as a process, started from exactly the files the
// Messages API image's Dockerfile copies, with real Chromium at playwright-core's revision; skipped
// when that browser is not installed (CI's test job), and run inside the built image by CI's
// container check instead (scripts/check-agent-container.sh). Only 127.0.0.1 is used.

const dirs: string[] = [];
const scratch = (prefix = "foreman-browser-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
/** Unpacked sites are read-only: their folders are made writable again so they can be removed. */
function writable(dir: string): void {
  if (!lstatSync(dir).isDirectory()) return;
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) writable(join(dir, name));
}
afterAll(() => {
  for (const dir of dirs.splice(0)) {
    writable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

const answer = (extra: Partial<PageAnswer> = {}): PageAnswer => ({
  path: "/",
  status: 200,
  title: "Fixture",
  snapshot: '- heading "Fixture" [ref=e1]',
  console: [],
  requests: [],
  dialogs: [],
  popupsClosed: 0,
  downloadsRefused: 0,
  fileChoosersIgnored: 0,
  ...extra,
});

describe("the tool API's inputs (unit: what each endpoint takes)", () => {
  it("takes a path that starts with one / and stays on the site, up to 2000 characters", () => {
    for (const path of [
      "/",
      "/gallery",
      "/a/b?c=d#e",
      "/http://x",
      "/%2F%2Fx",
      `/${"a".repeat(1999)}`,
    ]) {
      expect(isSitePath(path), path).toBe(true);
    }
    for (const path of [
      "",
      "gallery",
      "//evil.example/x",
      "/\\evil.example",
      "http://127.0.0.1:1/",
      "javascript:alert(1)",
      "/a b",
      "/a\tb",
      "/a\nb",
      "/a\u007fb",
      `/${"a".repeat(2000)}`,
      42,
      null,
    ]) {
      expect(isSitePath(path), String(path)).toBe(false);
    }
  });

  it("takes open with exactly a path and a viewport", () => {
    expect(parseOpen({ path: "/x", viewport: "mobile" })).toEqual({
      input: { path: "/x", viewport: "mobile" },
    });
    expect(parseOpen({ path: "/x", viewport: "tablet" })).toEqual({
      error: BROWSER_API_ERRORS.viewport,
    });
    expect(parseOpen({ path: "//x", viewport: "desktop" })).toEqual({
      error: BROWSER_API_ERRORS.path,
    });
    for (const body of [
      { viewport: "desktop" },
      { path: "/", viewport: "desktop", url: "x" },
      [],
      "x",
      null,
    ]) {
      expect(parseOpen(body)).toEqual({ error: BROWSER_API_ERRORS.openFields });
    }
  });

  it("takes act with a ref from the last snapshot, a value only where it is needed, and press's fixed keys", () => {
    expect(parseAct({ action: "click", ref: "e2" })).toEqual({
      input: { action: "click", ref: "e2" },
    });
    expect(parseAct({ action: "hover", ref: "f1e3" })).toEqual({
      input: { action: "hover", ref: "f1e3" },
    });
    expect(parseAct({ action: "fill", ref: "e4", value: "" })).toEqual({
      input: { action: "fill", ref: "e4", value: "" },
    });
    expect(
      parseAct({ action: "fill", ref: "e4", value: "x".repeat(1000) }),
    ).toMatchObject({
      input: { action: "fill" },
    });
    expect(parseAct({ action: "select", ref: "e5", value: "b" })).toMatchObject({
      input: { value: "b" },
    });
    for (const key of KEYS) {
      expect(parseAct({ action: "press", ref: "e1", value: key })).toMatchObject({
        input: { action: "press", value: key },
      });
    }
    expect(parseAct({ action: "back" })).toEqual({ input: { action: "back" } });

    const refused: [unknown, string][] = [
      [{ action: "evaluate", ref: "e1" }, BROWSER_API_ERRORS.action],
      [
        { action: "setInputFiles", ref: "e1", value: "/etc/passwd" },
        BROWSER_API_ERRORS.action,
      ],
      [{ action: "click" }, BROWSER_API_ERRORS.ref],
      [{ action: "click", ref: "button" }, BROWSER_API_ERRORS.ref],
      [{ action: "click", ref: "css=button" }, BROWSER_API_ERRORS.ref],
      [{ action: "click", ref: `e${"1".repeat(30)}` }, BROWSER_API_ERRORS.ref],
      [{ action: "back", ref: "e1" }, BROWSER_API_ERRORS.ref],
      [{ action: "back", value: "x" }, BROWSER_API_ERRORS.value],
      [{ action: "click", ref: "e1", value: "x" }, BROWSER_API_ERRORS.value],
      [{ action: "fill", ref: "e1" }, BROWSER_API_ERRORS.value],
      [{ action: "fill", ref: "e1", value: 3 }, BROWSER_API_ERRORS.value],
      [
        { action: "fill", ref: "e1", value: "x".repeat(1001) },
        BROWSER_API_ERRORS.value,
      ],
      [{ action: "select", ref: "e1", value: "" }, BROWSER_API_ERRORS.value],
      [{ action: "press", ref: "e1", value: "Control+W" }, BROWSER_API_ERRORS.key],
      [{ action: "press", ref: "e1", value: "a" }, BROWSER_API_ERRORS.key],
      [{ action: "click", ref: "e1", frame: "x" }, BROWSER_API_ERRORS.actFields],
      ["click", BROWSER_API_ERRORS.actFields],
    ];
    for (const [body, error] of refused)
      expect(parseAct(body), JSON.stringify(body)).toEqual({ error });
  });

  it("takes read with exactly one of its four views", () => {
    for (const view of ["snapshot", "text", "console", "network"]) {
      expect(parseRead({ view })).toEqual({ input: { view } });
    }
    expect(parseRead({ view: "screenshot" })).toEqual({
      error: BROWSER_API_ERRORS.view,
    });
    expect(parseRead({ view: "text", full: true })).toEqual({
      error: BROWSER_API_ERRORS.readFields,
    });
  });

  it("takes application/json only, with at most a UTF-8 charset", () => {
    expect(isJsonType("application/json")).toBe(true);
    expect(isJsonType("Application/JSON; charset=UTF-8")).toBe(true);
    for (const type of [
      undefined,
      "",
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/json; charset=latin1",
      "application/json; boundary=x",
      "application/jsonx",
    ]) {
      expect(isJsonType(type), String(type)).toBe(false);
    }
  });
});

interface Sent {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One raw request, so the method, headers and body are exactly the test's. */
function send(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  },
): Promise<Sent> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/read",
        headers: options.headers ?? { "content-type": "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          done({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", fail);
    req.end(options.body);
  });
}

describe("the tool API (unit: a fake session, ADR 0119 slice 5b)", () => {
  let server: Server;
  let port: number;
  let lines: string[];
  const calls: unknown[] = [];
  let next: () => Promise<PageAnswer> = async () => answer();
  const session: BrowserSession = {
    open: async (input) => (calls.push(["open", input]), next()),
    act: async (input) => (calls.push(["act", input]), next()),
    read: async (input) => (calls.push(["read", input]), next()),
    close: async () => {},
    onGone: () => {},
  };

  beforeAll(async () => {
    lines = [];
    const logger = createLogger("browser-host", (line) => lines.push(line));
    server = createServer(browserApi(session, logger, { timeLimitMs: 300 }));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  afterEach(() => {
    calls.length = 0;
    next = async () => answer();
  });

  it("answers each endpoint with the session's answer as JSON, with no CORS header", async () => {
    const opened = await send(port, {
      path: "/open",
      body: JSON.stringify({ path: "/gallery", viewport: "desktop" }),
    });
    expect(opened.status).toBe(200);
    expect(opened.headers["content-type"]).toBe("application/json");
    expect(opened.headers["access-control-allow-origin"]).toBeUndefined();
    expect(JSON.parse(opened.body)).toEqual(answer());
    await send(port, {
      path: "/act",
      body: JSON.stringify({ action: "click", ref: "e1" }),
    });
    await send(port, { path: "/read", body: JSON.stringify({ view: "console" }) });
    expect(calls).toEqual([
      ["open", { path: "/gallery", viewport: "desktop" }],
      ["act", { action: "click", ref: "e1" }],
      ["read", { view: "console" }],
    ]);
  });

  it("refuses a GET, a preflight and every other method, with no CORS header", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "PATCH"]) {
      const res = await send(port, {
        method,
        headers: {
          origin: "http://127.0.0.1:4173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.allow).toBe("POST");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-allow-methods"]).toBeUndefined();
    }
    expect(calls).toEqual([]);
  });

  it("refuses a body that is not JSON, as a page's form or simple request sends it", async () => {
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
    ]) {
      const res = await send(port, {
        headers: { "content-type": type },
        body: '{"view":"text"}',
      });
      expect(res.status, type).toBe(415);
      expect(JSON.parse(res.body)).toEqual({ error: BROWSER_API_ERRORS.contentType });
    }
    const none = await send(port, { headers: {}, body: '{"view":"text"}' });
    expect(none.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it("refuses a request that carries an Origin, as a browser's POST does", async () => {
    const res = await send(port, {
      headers: { "content-type": "application/json", origin: "null" },
      body: '{"view":"text"}',
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: BROWSER_API_ERRORS.origin });
    expect(calls).toEqual([]);
  });

  it("refuses an unknown endpoint, a query and a body past its bound, by length or as it arrives", async () => {
    expect((await send(port, { path: "/evaluate", body: "{}" })).status).toBe(404);
    expect((await send(port, { path: "/read?view=text", body: "{}" })).status).toBe(
      404,
    );
    const big = JSON.stringify({ view: "text", pad: "x".repeat(MAX_BODY_BYTES) });
    const byLength = await send(port, { body: big });
    expect(byLength.status).toBe(413);
    expect(JSON.parse(byLength.body)).toEqual({ error: BROWSER_API_ERRORS.tooLarge });
    const chunked = await new Promise<number>((done, fail) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/read",
          headers: {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          done(res.statusCode ?? 0);
        },
      );
      req.on("error", fail);
      req.write("x".repeat(MAX_BODY_BYTES));
      req.end("x".repeat(100));
    });
    expect(chunked).toBe(413);
    expect(calls).toEqual([]);
  });

  it("refuses bad JSON and bad fields with fixed texts, before the session is called", async () => {
    const notJson = await send(port, { body: "{view" });
    expect(notJson.status).toBe(400);
    expect(JSON.parse(notJson.body)).toEqual({ error: BROWSER_API_ERRORS.notJson });
    const badPath = await send(port, {
      path: "/open",
      body: JSON.stringify({ path: "https://example.com/", viewport: "desktop" }),
    });
    expect(badPath.status).toBe(400);
    expect(JSON.parse(badPath.body)).toEqual({ error: BROWSER_API_ERRORS.path });
    const badAction = await send(port, {
      path: "/act",
      body: JSON.stringify({ action: "evaluate", ref: "e1", value: "fetch('x')" }),
    });
    expect(JSON.parse(badAction.body)).toEqual({ error: BROWSER_API_ERRORS.action });
    expect(calls).toEqual([]);
  });

  it("maps the session's failures to fixed answers", async () => {
    next = async () => {
      throw new NoPageError("x");
    };
    const noPage = await send(port, { body: '{"view":"snapshot"}' });
    expect([noPage.status, JSON.parse(noPage.body)]).toEqual([
      409,
      { error: BROWSER_API_ERRORS.noPage },
    ]);
    next = async () => {
      throw new ActionError(ACTION_ERRORS.timeout);
    };
    const action = await send(port, {
      path: "/act",
      body: '{"action":"click","ref":"e9"}',
    });
    expect([action.status, JSON.parse(action.body)]).toEqual([
      422,
      { error: ACTION_ERRORS.timeout },
    ]);
    next = async () => {
      throw new Error("page said: secret-looking text");
    };
    const failed = await send(port, { body: '{"view":"text"}' });
    expect([failed.status, failed.body]).toEqual([
      500,
      JSON.stringify({ error: BROWSER_API_ERRORS.failed }),
    ]);
  });

  it("answers 504 past the time limit, and 409 while the browser is still busy with it", async () => {
    let release = () => {};
    next = () => new Promise((done) => (release = () => done(answer())));
    const slow = await send(port, { body: '{"view":"text"}' });
    expect([slow.status, JSON.parse(slow.body)]).toEqual([
      504,
      { error: BROWSER_API_ERRORS.timeLimit },
    ]);
    const busy = await send(port, { body: '{"view":"text"}' });
    expect([busy.status, JSON.parse(busy.body)]).toEqual([
      409,
      { error: BROWSER_API_ERRORS.busy },
    ]);
    release();
    await new Promise((done) => setTimeout(done, 20));
    next = async () => answer();
    expect((await send(port, { body: '{"view":"text"}' })).status).toBe(200);
  });

  it("logs only the endpoint, the status, the size and the time of each request", async () => {
    lines.length = 0;
    await send(port, {
      path: "/act",
      body: JSON.stringify({
        action: "fill",
        ref: "e2",
        value: "do-not-log-this-value",
      }),
    });
    await send(port, { path: "/secret-path-not-logged", body: "{}" });
    await send(port, {
      path: "/open",
      body: JSON.stringify({ path: "/do-not-log-this-path", viewport: "desktop" }),
    });
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const fields = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(fields).sort()).toEqual(
        [
          "bytes",
          "durationMs",
          "endpoint",
          "level",
          "message",
          "service",
          "status",
          "time",
        ].sort(),
      );
      expect(line).not.toMatch(/do-not-log|secret-path|e2|Fixture/);
    }
    expect(lines.map((l) => JSON.parse(l).endpoint)).toEqual([
      "/act",
      "other",
      "/open",
    ]);
  });
});

describe("the site (unit: unpacked read-only, served on 127.0.0.1 with the backend off, D-478)", () => {
  const site = () =>
    storedZip([
      { name: "index.html", data: "<title>Home</title>", deflate: true },
      { name: "assets/app.js", data: "console.log(1)" },
      { name: "docs/index.html", data: "<title>Docs</title>" },
      { name: ".env", data: "SECRET=not-real" },
    ]);

  it("unpacks every file into its own folder, files 0444 and folders 0555", () => {
    const root = scratch();
    const folder = unpackSite(site(), root);
    expect(folder).toBe(join(root, "site"));
    expect(readFileSync(join(folder, "assets/app.js"), "utf8")).toBe("console.log(1)");
    expect(statSync(join(folder, "index.html")).mode & 0o777).toBe(0o444);
    expect(statSync(join(folder, "assets")).mode & 0o777).toBe(0o555);
    expect(statSync(folder).mode & 0o777).toBe(0o555);
  });

  it.each<[string, Uint8Array | (() => Uint8Array), string]>([
    ["not a zip", new TextEncoder().encode("<html>"), SITE_REFUSALS.unreadable],
    [
      "a path out of the site",
      () => storedZip([{ name: "../x.html", data: "x" }]),
      SITE_REFUSALS.unreadable,
    ],
    [
      "an absolute path",
      () => storedZip([{ name: "/etc/x", data: "x" }]),
      SITE_REFUSALS.unreadable,
    ],
    [
      "a symbolic link",
      () => storedZip([{ name: "index.html", data: "/etc/passwd", mode: 0o120777 }]),
      SITE_REFUSALS.link,
    ],
    ["no file", () => storedZip([]), SITE_REFUSALS.empty],
    [
      "a file where a folder is",
      () =>
        storedZip([
          { name: "a", data: "x" },
          { name: "a/b.html", data: "x" },
        ]),
      SITE_REFUSALS.conflict,
    ],
    [
      "past the unpacked bound",
      () =>
        storedZip([
          { name: "big.txt", data: Buffer.alloc(17 * 1024 * 1024), deflate: true },
        ]),
      SITE_REFUSALS.bound,
    ],
  ])("refuses %s, naming nothing from the zip", (_name, zip, reason) => {
    const root = scratch();
    expect(() => unpackSite(typeof zip === "function" ? zip() : zip, root)).toThrow(
      reason,
    );
  });

  it("refuses a folder that is not empty", () => {
    const root = scratch();
    writeFileSync(join(root, "x"), "x");
    expect(() => unpackSite(site(), root)).toThrow(SITE_REFUSALS.notEmpty);
  });

  it("serves the site with its single-page fallback, never a dot file, and 503 with a fixed text on /api", async () => {
    const folder = unpackSite(site(), scratch());
    const { server, origin } = await startSite(folder);
    try {
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const get = async (path: string, method = "GET") => {
        const res = await fetch(`${origin}${path}`, { method });
        return [res.status, await res.text()];
      };
      expect(await get("/")).toEqual([200, "<title>Home</title>"]);
      expect(await get("/docs/")).toEqual([200, "<title>Docs</title>"]);
      expect(await get("/some/route")).toEqual([200, "<title>Home</title>"]);
      expect(await get("/.env")).toEqual([404, ""]);
      for (const path of [
        "/api",
        "/api/",
        "/api/health",
        "/api/x?y=1",
        "/%61pi/health",
      ]) {
        expect(await get(path), path).toEqual([503, BACKEND_OFF_TEXT]);
      }
      expect(await get("/api/items", "POST")).toEqual([503, BACKEND_OFF_TEXT]);
      expect(await get("/apis")).toEqual([200, "<title>Home</title>"]);
      expect(isBackendPath("/API/x")).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("the host's settings and Chromium's options (unit)", () => {
  const good = {
    FOREMAN_SITE_ZIP: "/site-zip/site.zip",
    FOREMAN_SITE_DIR: "/site",
    FOREMAN_BROWSER_LISTEN: "10.244.0.12",
    FOREMAN_BROWSER_PORT: "8090",
    FOREMAN_BROWSER_DEADLINE_SECONDS: "1230",
  };

  it("reads its five settings, and names every problem but never a value", () => {
    expect(readConfig(BROWSER_HOST_SETTINGS, good)).toEqual({
      siteZip: "/site-zip/site.zip",
      siteDir: "/site",
      listen: "10.244.0.12",
      port: 8090,
      deadlineSeconds: 1230,
    });
    expect(() => readConfig(BROWSER_HOST_SETTINGS, {})).toThrow(
      /FOREMAN_SITE_ZIP is not set.*FOREMAN_SITE_DIR is not set.*FOREMAN_BROWSER_LISTEN is not set.*FOREMAN_BROWSER_PORT is not set.*FOREMAN_BROWSER_DEADLINE_SECONDS is not set/,
    );
    const bad = {
      FOREMAN_SITE_ZIP: "site.zip",
      FOREMAN_SITE_DIR: "relative-secret-value",
      FOREMAN_BROWSER_LISTEN: "0.0.0.0",
      FOREMAN_BROWSER_PORT: "70000",
      FOREMAN_BROWSER_DEADLINE_SECONDS: "0",
    };
    let message = "";
    try {
      readConfig(BROWSER_HOST_SETTINGS, bad);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("FOREMAN_SITE_ZIP is not an absolute path");
    expect(message).toContain("FOREMAN_BROWSER_LISTEN must be one address");
    expect(message).toContain("FOREMAN_BROWSER_PORT is not a port number");
    expect(message).toContain("FOREMAN_BROWSER_DEADLINE_SECONDS is not a whole number");
    expect(message).not.toContain("relative-secret-value");
    expect(() =>
      readConfig(BROWSER_HOST_SETTINGS, {
        ...good,
        FOREMAN_BROWSER_LISTEN: "browser.local",
      }),
    ).toThrow(/FOREMAN_BROWSER_LISTEN is not an IP address/);
  });

  it("launches Chromium headless over its pipe, behind a closed proxy only the site bypasses, with no name resolving", () => {
    const options = chromiumLaunchOptions("http://127.0.0.1:41000", 41001, {
      PATH: "/usr/bin",
      HOME: "/tmp",
      TMPDIR: "/tmp",
      FOREMAN_SITE_ZIP: "/site-zip/site.zip",
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
    });
    expect(options.headless).toBe(true);
    expect(options.proxy).toEqual({
      server: "http://127.0.0.1:41001",
      bypass: "<-loopback>,127.0.0.1:41000",
    });
    expect(options.args).toEqual([
      "--disable-background-networking",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      "--no-pings",
    ]);
    // Playwright adds --remote-debugging-pipe itself; nothing asks for a DevTools port.
    expect(JSON.stringify(options)).not.toMatch(
      /remote-debugging-port|remote-debugging-address/,
    );
    expect(options.env).toEqual({ PATH: "/usr/bin", HOME: "/tmp", TMPDIR: "/tmp" });
    expect(options.chromiumSandbox).toBeUndefined();
  });

  it("bounds every part of an answer", () => {
    expect(BROWSER_LIMITS).toMatchObject({
      pathChars: 2000,
      valueChars: 1000,
      consoleEntries: 30,
      requestEntries: 30,
      snapshotBytes: 12 * 1024,
      textBytes: 12 * 1024,
    });
  });
});

describe("the host's start (unit: fails closed, naming the step, never a value)", () => {
  const run = async (env: Record<string, string>) => {
    const lines: string[] = [];
    const code = await runBrowserHost(
      env,
      createLogger("browser-host", (line) => lines.push(line)),
    );
    return { code, lines: lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
  };

  it("exits 1 with every missing setting named", async () => {
    const { code, lines } = await run({});
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      message: "browser host settings",
    });
    expect(lines[0]?.problems).toHaveLength(5);
  });

  it("exits 1 on a site zip it cannot read or unpack, before Chromium starts", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "site.zip"), storedZip([{ name: "../escape", data: "x" }]));
    const env = {
      FOREMAN_SITE_ZIP: join(dir, "site.zip"),
      FOREMAN_SITE_DIR: join(dir, "memory"),
      FOREMAN_BROWSER_LISTEN: "127.0.0.1",
      FOREMAN_BROWSER_PORT: "0",
      FOREMAN_BROWSER_DEADLINE_SECONDS: "5",
    };
    const bad = await run(env);
    expect(bad.code).toBe(1);
    expect(bad.lines[0]).toMatchObject({
      step: "site",
      reason: SITE_REFUSALS.unreadable,
    });
    const missing = await run({ ...env, FOREMAN_SITE_ZIP: join(dir, "none.zip") });
    expect(missing.lines[0]).toMatchObject({
      step: "site_zip",
      reason: START_REFUSALS.siteZip,
    });
  });
});

/** The files the Messages API image's Dockerfile copies, at their paths under a fresh /app. */
function imageFiles(): string {
  const app = scratch("foreman-browser-image-");
  const dockerfile = readFileSync("src/agent-images/claude-api/Dockerfile", "utf8");
  for (const line of dockerfile.split("\n")) {
    const copy = /^COPY\s+(.+)\s+(\S+)$/.exec(line);
    if (!copy) continue;
    const sources = (copy[1] as string).split(/\s+/);
    const target = copy[2] as string;
    for (const source of sources) {
      const to = target.endsWith("/")
        ? join(app, target, source.split("/").at(-1) as string)
        : join(app, target);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(source, to, { recursive: true });
    }
  }
  // What `npm ci` installs; the test links this checkout's.
  symlinkSync(resolve("node_modules"), join(app, "node_modules"));
  return app;
}

describe.skipIf(!headlessShellInstalled)(
  "the browser host with real Chromium (broader: a process from the image's files)",
  { timeout: 60_000 },
  () => {
    let host: ChildProcess;
    let base: string;
    let stdout = "";
    const consoleErrors = 33;

    beforeAll(async () => {
      const app = imageFiles();
      const work = scratch();
      mkdirSync(join(work, "memory"));
      const long = Array.from({ length: 4000 }, (_, i) => `<li>Item ${i}</li>`).join(
        "",
      );
      writeFileSync(
        join(work, "site.zip"),
        storedZip([
          {
            name: "index.html",
            deflate: true,
            data: `<!doctype html><title>Home</title><h1>Fixture home</h1>
<a href="/about">About</a>
<label>Name <input name="name"></label>
<select aria-label="Size"><option>small</option><option>large</option></select>
<label><input type="checkbox"> Agree</label>
<button type="button" onclick="alert('saved'); document.title = 'Saved'">Save</button>
<button type="button" onclick="window.open('/about')">Pop</button>
<script>
  fetch("/api/items");
  fetch("https://tracker.example.com/pixel?user=someone&path=/private");
  for (let i = 0; i < ${consoleErrors}; i++) console.error("error " + i);
</script>`,
          },
          { name: "about/index.html", data: "<title>About</title><p>About us</p>" },
          { name: "long/index.html", data: `<title>Long</title><ul>${long}</ul>` },
        ]),
      );
      host = spawn(
        process.execPath,
        [join(app, "src/agent-images/claude-api/browser-host.ts")],
        {
          cwd: app,
          env: {
            PATH: process.env.PATH,
            HOME: work,
            TMPDIR: work,
            FOREMAN_SITE_ZIP: join(work, "site.zip"),
            FOREMAN_SITE_DIR: join(work, "memory"),
            FOREMAN_BROWSER_LISTEN: "127.0.0.1",
            FOREMAN_BROWSER_PORT: "0",
            FOREMAN_BROWSER_DEADLINE_SECONDS: "120",
            ...(process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
              ? {}
              : { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }),
          },
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      host.stdout?.on("data", (chunk) => (stdout += chunk));
      const port = await new Promise<number>((done, fail) => {
        const timer = setInterval(() => {
          const line = stdout
            .split("\n")
            .find((l) => l.includes('"message":"listening"'));
          if (line) {
            clearInterval(timer);
            done(JSON.parse(line).port as number);
          } else if (host.exitCode !== null) {
            clearInterval(timer);
            fail(new Error("the browser host exited"));
          }
        }, 50);
      });
      base = `http://127.0.0.1:${port}`;
    }, 60_000);

    afterAll(async () => {
      if (host.exitCode === null) {
        host.kill("SIGTERM");
        await new Promise((done) => host.once("exit", done));
      }
    });

    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        body: (await res.json()) as PageAnswer & { error?: string },
      };
    };
    const refOf = (snapshot: string | undefined, label: string) =>
      new RegExp(`${label}[^\\n]*?\\[ref=([a-z0-9]+)\\]`).exec(snapshot ?? "")?.[1] ??
      "none";

    it("refuses act and read before a page is open", async () => {
      expect(await post("/read", { view: "snapshot" })).toEqual({
        status: 409,
        body: { error: BROWSER_API_ERRORS.noPage },
      });
    });

    it("opens a page: path, status, title, the snapshot with refs and boxes, console errors and requests, each bounded", async () => {
      const { status, body } = await post("/open", { path: "/", viewport: "desktop" });
      expect(status).toBe(200);
      expect(body).toMatchObject({ path: "/", status: 200, title: "Home" });
      expect(body.snapshot).toMatch(
        /heading "Fixture home" \[level=1\] \[ref=e\d+\] \[box=\d+,\d+,\d+,\d+\]/,
      );
      expect(body.console).toHaveLength(BROWSER_LIMITS.consoleEntries);
      expect(body.consoleDropped).toBeGreaterThan(0);
      // The blocked request names its scheme and host, never its path or query.
      expect(body.requests).toContainEqual({
        kind: "blocked",
        scheme: "https",
        host: "tracker.example.com",
      });
      expect(JSON.stringify(body)).not.toMatch(/pixel|someone|private/);
      // The backend is off (D-478).
      expect(body.requests).toContainEqual({
        kind: "status",
        path: "/api/items",
        status: 503,
      });
    });

    it("acts by ref: fill, select, check, then a click whose dialog is dismissed and reported", async () => {
      const page = (await post("/read", { view: "snapshot" })).body.snapshot;
      expect(
        (
          await post("/act", {
            action: "fill",
            ref: refOf(page, 'textbox "Name"'),
            value: "Ada",
          })
        ).body.snapshot,
      ).toMatch(/textbox "Name"[^\n]*: Ada/);
      expect(
        (
          await post("/act", {
            action: "select",
            ref: refOf(page, 'combobox "Size"'),
            value: "large",
          })
        ).body.snapshot,
      ).toMatch(/option "large" \[selected\]/);
      expect(
        (await post("/act", { action: "check", ref: refOf(page, 'checkbox "Agree"') }))
          .body.snapshot,
      ).toMatch(/checkbox "Agree" \[checked\]/);
      const saved = await post("/act", {
        action: "click",
        ref: refOf(page, 'button "Save"'),
      });
      expect(saved.body.dialogs).toEqual([{ type: "alert", message: "saved" }]);
      expect(saved.body.title).toBe("Saved");
      expect(
        (
          await post("/act", {
            action: "press",
            ref: refOf(page, 'button "Save"'),
            value: "Tab",
          })
        ).status,
      ).toBe(200);
      expect(
        (await post("/act", { action: "hover", ref: refOf(page, 'link "About"') }))
          .status,
      ).toBe(200);
    });

    it("closes and reports a popup, follows a link and goes back", async () => {
      const page = (await post("/read", { view: "snapshot" })).body.snapshot;
      const popped = await post("/act", {
        action: "click",
        ref: refOf(page, 'button "Pop"'),
      });
      await new Promise((done) => setTimeout(done, 300));
      const after = await post("/read", { view: "console" });
      expect(popped.body.popupsClosed + after.body.popupsClosed).toBe(1);
      const about = await post("/act", {
        action: "click",
        ref: refOf(page, 'link "About"'),
      });
      expect(about.body).toMatchObject({ path: "/about", status: 200, title: "About" });
      const back = await post("/act", { action: "back" });
      expect(back.body).toMatchObject({ path: "/", title: "Home" });
    });

    it("refuses a ref that is not on the page with a fixed text", async () => {
      const missing = await post("/act", { action: "click", ref: "e99999" });
      expect(missing.status).toBe(422);
      expect(Object.values(ACTION_ERRORS)).toContain(missing.body.error);
    });

    it("reads text, and cuts a long snapshot and text at their bounds", async () => {
      const long = await post("/open", { path: "/long", viewport: "mobile" });
      expect(long.body.cut).toBe(true);
      expect(Buffer.byteLength(long.body.snapshot ?? "")).toBeLessThanOrEqual(
        BROWSER_LIMITS.snapshotBytes,
      );
      const text = await post("/read", { view: "text" });
      expect(text.body.text).toMatch(/^Item 0\nItem 1\n/);
      expect(Buffer.byteLength(text.body.text ?? "")).toBeLessThanOrEqual(
        BROWSER_LIMITS.textBytes,
      );
      expect(text.body.snapshot).toBeUndefined();
    });

    it("refuses a path off the site, a GET and a body that is not JSON", async () => {
      expect(
        (await post("/open", { path: "//example.com/", viewport: "desktop" })).status,
      ).toBe(400);
      expect((await fetch(`${base}/read`)).status).toBe(405);
      const text = await fetch(`${base}/read`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: '{"view":"text"}',
      });
      expect(text.status).toBe(415);
    });

    it("logs one line a request with the endpoint, status, size and time only, then stops cleanly on SIGTERM", async () => {
      host.kill("SIGTERM");
      const code = await new Promise((done) => host.once("exit", done));
      expect(code).toBe(0);
      const lines = stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines[0]).toMatchObject({ message: "listening" });
      expect(lines.at(-1)).toMatchObject({ message: "stopped", reason: "signal" });
      for (const line of lines.filter((l) => l.message === "browser request")) {
        expect(Object.keys(line).sort()).toEqual(
          [
            "bytes",
            "durationMs",
            "endpoint",
            "level",
            "message",
            "service",
            "status",
            "time",
          ].sort(),
        );
      }
      expect(stdout).not.toMatch(/Ada|tracker|Fixture home|Item 0/);
    });
  },
);

describe.skipIf(!headlessShellInstalled)(
  "the browser host's deadline (broader: real Chromium)",
  () => {
    it("stops by itself at its deadline and exits 0", async () => {
      const work = scratch();
      mkdirSync(join(work, "memory"));
      writeFileSync(
        join(work, "site.zip"),
        storedZip([{ name: "index.html", data: "<p>x</p>" }]),
      );
      const lines: string[] = [];
      const code = await runBrowserHost(
        {
          ...process.env,
          HOME: work,
          TMPDIR: work,
          FOREMAN_SITE_ZIP: join(work, "site.zip"),
          FOREMAN_SITE_DIR: join(work, "memory"),
          FOREMAN_BROWSER_LISTEN: "127.0.0.1",
          FOREMAN_BROWSER_PORT: "0",
          FOREMAN_BROWSER_DEADLINE_SECONDS: "2",
        },
        createLogger("browser-host", (line) => lines.push(line)),
      );
      expect(code).toBe(0);
      expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
        message: "stopped",
        reason: "deadline",
      });
      expect(existsSync(join(work, "memory", "site", "index.html"))).toBe(true);
    }, 60_000);
  },
);
