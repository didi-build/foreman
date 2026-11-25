// The browser host's Chromium (ADR 0119 slice 5b, D-476, D-477): one headless Chromium, driven by
// playwright-core at the exact version package.json pins, that can reach the site under test and
// nothing else. The page is untrusted code, so every layer below holds on its own:
//
// - Playwright talks to Chromium over a pipe (`--remote-debugging-pipe`, its default): no DevTools
//   port is ever open.
// - Chromium's proxy is a closed port on 127.0.0.1, and only the site's own host and port bypass it
//   (`<-loopback>` first, so no other loopback port is reached directly). Anything that slips past
//   the routes below goes to the closed port and fails. No name resolves (`--host-resolver-rules`),
//   WebRTC sends no UDP that the proxy does not carry, and background networking is off.
// - `context.route` lets through requests to the site's own origin only and aborts every other
//   one; `context.routeWebSocket` does the same for WebSockets. Each blocked request is recorded by
//   its URL's scheme and host only, never the full URL.
// - Service workers are blocked, no permission is granted, downloads are refused, a file chooser is
//   never answered, dialogs are dismissed and popups closed, and each is reported.
//
// The host never evaluates code that a request names, never uploads a file and never downloads one:
// it opens a path on the site, acts on an element by its `aria-ref` from the last snapshot, and
// reads the page. Each answer carries the page's path, status and title, and the console errors and
// the failed or blocked requests since the last answer, each part bounded.
import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Locator,
  type Page,
  type Request,
  type Response,
  type Route,
  type WebSocketRoute,
} from "playwright-core";

import { cutUtf8 } from "../shared/context-tools.ts";

export const VIEWPORTS = {
  desktop: {
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
  },
  mobile: {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  },
} as const;
export type Viewport = keyof typeof VIEWPORTS;
export const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as Viewport[];

export const ACTIONS = [
  "click",
  "fill",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "back",
] as const;
export type Action = (typeof ACTIONS)[number];

/** The keys `press` takes, by Playwright's names. */
export const KEYS = [
  "Enter",
  "Tab",
  "Shift+Tab",
  "Escape",
  "Space",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;

export const VIEWS = ["snapshot", "text", "console", "network"] as const;
export type View = (typeof VIEWS)[number];

/** The bounds of every part of an answer, and the time each step may take. */
export const BROWSER_LIMITS = {
  pathChars: 2_000,
  valueChars: 1_000,
  refChars: 24,
  snapshotBytes: 12 * 1024,
  textBytes: 12 * 1024,
  titleChars: 200,
  consoleEntries: 30,
  consoleEntryChars: 500,
  requestEntries: 30,
  requestPathChars: 200,
  requestErrorChars: 100,
  hostChars: 255,
  dialogEntries: 10,
  dialogChars: 300,
  navigationMs: 8_000,
  actionMs: 4_000,
  settleMs: 1_000,
  readMs: 3_000,
} as const;

export interface OpenInput {
  path: string;
  viewport: Viewport;
}
export interface ActInput {
  action: Action;
  ref?: string;
  value?: string;
}
export interface ReadInput {
  view: View;
}

/** A request the page made that did not end well. A blocked one names only its scheme and host. */
export type RequestNote =
  | { kind: "blocked"; scheme: string; host: string }
  | { kind: "failed"; path: string; error: string }
  | { kind: "status"; path: string; status: number };

export interface DialogNote {
  type: string;
  message: string;
}

/** One answer of the host. Lists hold what happened since the last answer that carried them. */
export interface PageAnswer {
  /** The page's path, query and fragment on the site, or null off the site (an error page). */
  path: string | null;
  /** The status of the page's last navigation, or null when it had none. */
  status: number | null;
  title: string;
  /** `open` only: why the page did not finish loading within its time. */
  loadError?: "timeout" | "failed";
  snapshot?: string;
  text?: string;
  /** True when the snapshot or the text was cut at its bound. */
  cut?: true;
  console?: string[];
  consoleDropped?: number;
  requests?: RequestNote[];
  requestsDropped?: number;
  dialogs: DialogNote[];
  popupsClosed: number;
  downloadsRefused: number;
  fileChoosersIgnored: number;
}

/** No page is open yet: `act` and `read` need `open` first. */
export class NoPageError extends Error {}

/** An action that could not be done, with a fixed text that names nothing from the page. */
export class ActionError extends Error {}

/** A path that does not stay on the site. */
export class PathError extends Error {}

export const ACTION_ERRORS = {
  timeout:
    "The element was not ready in time: it may be hidden, disabled or covered. Read a new snapshot.",
  failed:
    "The action could not be done on that element. Read a new snapshot, and check the ref and the value.",
  noHistory: "There is no earlier page to go back to.",
} as const;

/** What `snapshot` holds when the page could not give one in time. */
export const NO_SNAPSHOT = "(The page gave no snapshot in time.)";

/** Chromium's launch options. Pure, so the test can check every layer. */
export function chromiumLaunchOptions(
  siteOrigin: string,
  closedPort: number,
  env: NodeJS.ProcessEnv,
): LaunchOptions {
  const site = new URL(siteOrigin);
  const browserEnv: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR"]) {
    const value = env[name];
    if (value !== undefined) browserEnv[name] = value;
  }
  return {
    headless: true,
    proxy: {
      server: `http://127.0.0.1:${closedPort}`,
      // The last rule that matches wins: no loopback address bypasses the proxy, except the site.
      bypass: `<-loopback>,${site.host}`,
    },
    args: [
      "--disable-background-networking",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${site.hostname}`,
      "--no-pings",
    ],
    // The host stops Chromium itself, on its deadline or its own signal.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    env: browserEnv,
    timeout: 30_000,
  };
}

/** A list that keeps its first `cap` items and counts the rest. */
class Pending<T> {
  private items: T[] = [];
  private dropped = 0;
  private readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  push(item: T): void {
    if (this.items.length < this.cap) this.items.push(item);
    else this.dropped += 1;
  }
  drain(): { items: T[]; dropped: number } {
    const drained = { items: this.items, dropped: this.dropped };
    this.items = [];
    this.dropped = 0;
    return drained;
  }
}

const cutChars = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max);

export interface BrowserSession {
  open(input: OpenInput): Promise<PageAnswer>;
  act(input: ActInput): Promise<PageAnswer>;
  read(input: ReadInput): Promise<PageAnswer>;
  close(): Promise<void>;
  /** Called once if Chromium goes away while the session is not closing. */
  onGone(listener: () => void): void;
}

interface Current {
  viewport: Viewport;
  context: BrowserContext;
  page: Page;
}

/** Launches Chromium for the site at `siteOrigin`, with its proxy on the closed port. */
export async function launchBrowserSession(options: {
  siteOrigin: string;
  closedPort: number;
  env: NodeJS.ProcessEnv;
}): Promise<BrowserSession> {
  const origin = new URL(options.siteOrigin).origin;
  const site = new URL(origin);
  const browser: Browser = await chromium.launch(
    chromiumLaunchOptions(origin, options.closedPort, options.env),
  );
  let closing = false;
  let goneListener: (() => void) | undefined;
  browser.on("disconnected", () => {
    if (!closing) goneListener?.();
  });

  const consoleErrors = new Pending<string>(BROWSER_LIMITS.consoleEntries);
  const requests = new Pending<RequestNote>(BROWSER_LIMITS.requestEntries);
  const dialogs = new Pending<DialogNote>(BROWSER_LIMITS.dialogEntries);
  let popupsClosed = 0;
  let downloadsRefused = 0;
  let fileChoosersIgnored = 0;
  let lastStatus: number | null = null;
  let current: Current | null = null;

  /** The site's own WebSocket origin: `ws:` on the site's host and port. */
  const onSiteSocket = (url: URL): boolean =>
    url.protocol === "ws:" && url.host === site.host;
  const parse = (raw: string): URL | null => {
    try {
      return new URL(raw);
    } catch {
      return null;
    }
  };
  const block = (url: URL | null): void => {
    requests.push({
      kind: "blocked",
      scheme: url ? url.protocol.replace(/:$/, "") : "unknown",
      host: url ? cutChars(url.host, BROWSER_LIMITS.hostChars) : "",
    });
  };
  const requestPath = (url: URL): string =>
    cutChars(url.pathname, BROWSER_LIMITS.requestPathChars);
  const isMainNavigation = (request: Request, page: Page): boolean => {
    try {
      return request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      return false;
    }
  };

  async function newContext(viewport: Viewport): Promise<Current> {
    const context = await browser.newContext({
      ...VIEWPORTS[viewport],
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      locale: "en-US",
      timezoneId: "UTC",
    });
    context.setDefaultTimeout(BROWSER_LIMITS.actionMs);
    context.setDefaultNavigationTimeout(BROWSER_LIMITS.navigationMs);
    await context.route(
      () => true,
      async (route: Route) => {
        const url = parse(route.request().url());
        if (url !== null && url.origin === origin) return route.continue();
        block(url);
        return route.abort("blockedbyclient");
      },
    );
    await context.routeWebSocket(
      () => true,
      (ws: WebSocketRoute) => {
        const url = parse(ws.url());
        if (url !== null && onSiteSocket(url)) {
          ws.connectToServer();
          return;
        }
        block(url);
        void ws.close({ code: 1008, reason: "blocked" }).catch(() => {});
      },
    );
    context.on("console", (message) => {
      if (message.type() !== "error") return;
      consoleErrors.push(cutChars(message.text(), BROWSER_LIMITS.consoleEntryChars));
    });
    context.on("weberror", (error) => {
      consoleErrors.push(
        cutChars(
          `Uncaught: ${error.error().message}`,
          BROWSER_LIMITS.consoleEntryChars,
        ),
      );
    });
    context.on("requestfailed", (request: Request) => {
      const url = parse(request.url());
      // A blocked request is already noted by its scheme and host, and nothing more.
      if (url === null || url.origin !== origin) return;
      if (current !== null && isMainNavigation(request, current.page))
        lastStatus = null;
      requests.push({
        kind: "failed",
        path: requestPath(url),
        error: cutChars(
          request.failure()?.errorText ?? "failed",
          BROWSER_LIMITS.requestErrorChars,
        ),
      });
    });
    context.on("response", (response: Response) => {
      const url = parse(response.url());
      if (url === null || url.origin !== origin) return;
      if (current !== null && isMainNavigation(response.request(), current.page)) {
        lastStatus = response.status();
      }
      if (response.status() >= 400) {
        requests.push({
          kind: "status",
          path: requestPath(url),
          status: response.status(),
        });
      }
    });
    context.on("dialog", (dialog) => {
      dialogs.push({
        type: dialog.type(),
        message: cutChars(dialog.message(), BROWSER_LIMITS.dialogChars),
      });
      void dialog.dismiss().catch(() => {});
    });
    // The first page of a context is the host's own; any later one is a popup.
    let own: Page | null = null;
    context.on("page", (page) => {
      if (own === null || page === own) return;
      popupsClosed += 1;
      void page.close().catch(() => {});
    });
    const page = await context.newPage();
    own = page;
    page.on("download", (download) => {
      downloadsRefused += 1;
      void download.cancel().catch(() => {});
    });
    // Listening intercepts the chooser; no file is ever set.
    page.on("filechooser", () => {
      fileChoosersIgnored += 1;
    });
    return { viewport, context, page };
  }

  const requirePage = (): Page => {
    if (current === null) throw new NoPageError("no page is open");
    return current.page;
  };

  async function settle(page: Page): Promise<void> {
    await page
      .waitForLoadState("load", { timeout: BROWSER_LIMITS.settleMs * 2 })
      .catch(() => {});
    await page
      .waitForLoadState("networkidle", { timeout: BROWSER_LIMITS.settleMs })
      .catch(() => {});
  }

  function pagePath(page: Page): string | null {
    const url = parse(page.url());
    if (url === null || url.origin !== origin) return null;
    return cutChars(
      `${url.pathname}${url.search}${url.hash}`,
      BROWSER_LIMITS.pathChars,
    );
  }

  async function answer(
    page: Page,
    parts: { snapshot?: true; text?: true; console?: true; requests?: true },
    extra: Pick<PageAnswer, "loadError"> = {},
  ): Promise<PageAnswer> {
    const result: Omit<
      PageAnswer,
      "dialogs" | "popupsClosed" | "downloadsRefused" | "fileChoosersIgnored"
    > = {
      path: pagePath(page),
      status: lastStatus,
      title: cutChars(await page.title().catch(() => ""), BROWSER_LIMITS.titleChars),
      ...extra,
    };
    if (parts.snapshot) {
      const snapshot = await page
        .ariaSnapshot({ mode: "ai", boxes: true, timeout: BROWSER_LIMITS.readMs })
        .catch(() => NO_SNAPSHOT);
      result.snapshot = cutUtf8(snapshot, BROWSER_LIMITS.snapshotBytes);
      if (result.snapshot !== snapshot) result.cut = true;
    }
    if (parts.text) {
      const text = await page
        .locator("body")
        .innerText({ timeout: BROWSER_LIMITS.readMs })
        .catch(() => "");
      result.text = cutUtf8(text, BROWSER_LIMITS.textBytes);
      if (result.text !== text) result.cut = true;
    }
    if (parts.console) {
      const { items, dropped } = consoleErrors.drain();
      result.console = items;
      if (dropped > 0) result.consoleDropped = dropped;
    }
    if (parts.requests) {
      const { items, dropped } = requests.drain();
      result.requests = items;
      if (dropped > 0) result.requestsDropped = dropped;
    }
    const reported = {
      dialogs: dialogs.drain().items,
      popupsClosed,
      downloadsRefused,
      fileChoosersIgnored,
    };
    popupsClosed = 0;
    downloadsRefused = 0;
    fileChoosersIgnored = 0;
    return { ...result, ...reported };
  }

  async function perform(locator: Locator, input: ActInput): Promise<void> {
    const value = input.value ?? "";
    switch (input.action) {
      case "click":
        return locator.click();
      case "fill":
        return locator.fill(value);
      case "press":
        return locator.press(value);
      case "select":
        await locator.selectOption(value);
        return;
      case "check":
        return locator.check();
      case "uncheck":
        return locator.uncheck();
      case "hover":
        return locator.hover();
      case "back":
        return;
    }
  }

  const both = { snapshot: true, console: true, requests: true } as const;

  return {
    async open(input) {
      const url = new URL(input.path, origin);
      if (url.origin !== origin) throw new PathError("the path leaves the site");
      if (current === null || current.viewport !== input.viewport) {
        const previous = current;
        current = null;
        await previous?.context.close().catch(() => {});
        current = await newContext(input.viewport);
      }
      const page = current.page;
      let loadError: PageAnswer["loadError"];
      try {
        const response = await page.goto(url.href, {
          waitUntil: "load",
          timeout: BROWSER_LIMITS.navigationMs,
        });
        lastStatus = response?.status() ?? null;
      } catch (error) {
        loadError = error instanceof errors.TimeoutError ? "timeout" : "failed";
      }
      await settle(page);
      return answer(page, both, loadError === undefined ? {} : { loadError });
    },

    async act(input) {
      const page = requirePage();
      if (input.action === "back") {
        const response = await page
          .goBack({ waitUntil: "load", timeout: BROWSER_LIMITS.navigationMs })
          .catch(() => undefined);
        if (response === null) throw new ActionError(ACTION_ERRORS.noHistory);
      } else {
        try {
          await perform(page.getByRef(input.ref ?? ""), input);
        } catch (error) {
          throw new ActionError(
            error instanceof errors.TimeoutError
              ? ACTION_ERRORS.timeout
              : ACTION_ERRORS.failed,
          );
        }
      }
      await settle(page);
      return answer(page, both);
    },

    async read(input) {
      const page = requirePage();
      switch (input.view) {
        case "snapshot":
          return answer(page, both);
        case "text":
          return answer(page, { text: true, console: true, requests: true });
        case "console":
          return answer(page, { console: true });
        case "network":
          return answer(page, { requests: true });
      }
    },

    async close() {
      closing = true;
      await browser.close().catch(() => {});
    },

    onGone(listener) {
      goneListener = listener;
    },
  };
}
