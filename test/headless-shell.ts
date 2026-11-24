// Test support: whether Chromium's headless shell, at the revision playwright-core's browsers.json
// names, is installed where playwright-core looks for it (PLAYWRIGHT_BROWSERS_PATH, or its own
// cache folder). The browser host's tests with real Chromium run only when it is, as the render
// step's test does for its browser (test/render-screenshots.test.ts); CI's test job has none, and
// CI's container check runs the same canary inside the built image instead.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface BrowserEntry {
  name: string;
  revision: string;
  browserVersion?: string;
}

/** playwright-core's entry for the headless shell, from the installed package's browsers.json. */
export function headlessShellEntry(): BrowserEntry {
  const { browsers } = JSON.parse(
    readFileSync("node_modules/playwright-core/browsers.json", "utf8"),
  ) as { browsers: BrowserEntry[] };
  const entry = browsers.find((b) => b.name === "chromium-headless-shell");
  if (!entry) throw new Error("playwright-core names no chromium-headless-shell");
  return entry;
}

/** Where playwright-core looks for the headless shell on Linux x64. */
export function headlessShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  const root =
    configured === "0"
      ? join("node_modules", "playwright-core", ".local-browsers")
      : (configured ?? join(homedir(), ".cache", "ms-playwright"));
  return join(
    root,
    `chromium_headless_shell-${headlessShellEntry().revision}`,
    "chrome-headless-shell-linux64",
    "chrome-headless-shell",
  );
}

export const headlessShellInstalled =
  process.platform === "linux" &&
  process.arch === "x64" &&
  existsSync(headlessShellPath());
