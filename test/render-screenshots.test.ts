// Broader: the render step end to end (scripts/render-screenshots.ts) with a real headless browser,
// against this repo's own gallery (components/example-button) and synthetic option pages
// (test/fixtures/screenshots/option-page) in a throwaway git repository, for the options a pull
// request changes and for every option at the head (D-281). The bundles it writes must pass the
// runner's manifest check. Skipped when no Playwright browser is installed, which is the
// case in CI's normal test job; the screenshots workflow runs the script in CI instead.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";

import { readScreenshotManifest } from "../src/core/visual-comparison.ts";
import { checkBundle } from "../scripts/lib/screenshot-bundle.ts";

const browserInstalled = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

/** Git without the session's injected config, with a fixed identity for the throwaway repo. */
const gitEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_CONFIG_")) delete env[key];
  return {
    ...env,
    GIT_AUTHOR_NAME: "Render Test",
    GIT_AUTHOR_EMAIL: "render-test@example.invalid",
    GIT_COMMITTER_NAME: "Render Test",
    GIT_COMMITTER_EMAIL: "render-test@example.invalid",
  };
})();
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: gitEnv,
    encoding: "utf8",
  }).trim();

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-render-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const render = (args: string[]) =>
  spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts/render-screenshots.ts"), ...args],
    {
      env: gitEnv,
      encoding: "utf8",
      timeout: 120_000,
    },
  );

describe.skipIf(!browserInstalled)(
  "render step end to end (broader: real browser)",
  () => {
    it("renders every gallery entry and variant into a bundle the runner accepts", () => {
      const commit = git(process.cwd(), "rev-parse", "HEAD");
      const out = join(scratch(), "gallery");
      const result = render(["--kind", "gallery", "--commit", commit, "--out", out]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "3 gallery shots, 1 spec files; manifest validated",
      );

      const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
      const read = readScreenshotManifest(manifest, commit, "gallery");
      expect("manifest" in read).toBe(true);
      expect(manifest.shots.map((s: { variant: string }) => s.variant)).toEqual([
        "Primary",
        "Secondary",
        "Disabled",
      ]);
      expect(checkBundle(out, commit, "gallery")).toEqual({
        summary: { kind: "gallery", images: 3, extras: 1 },
      });

      // The same commit renders the same pixels.
      const again = join(scratch(), "gallery");
      expect(
        render(["--kind", "gallery", "--commit", commit, "--out", again]).status,
      ).toBe(0);
      const hashes = (dir: string) =>
        JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).shots.map(
          (s: { sha256: string }) => s.sha256,
        );
      expect(hashes(again)).toEqual(hashes(out));
    }, 120_000);

    it("renders the option pages a pull request changes, with each marked region", () => {
      const repo = scratch();
      git(repo, "init", "-q", "-b", "main");
      mkdirSync(join(repo, "design/auth/old/options/calm"), { recursive: true });
      writeFileSync(
        join(repo, "design/auth/old/options/calm/index.html"),
        "<p>calm</p>\n",
      );
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      const base = git(repo, "rev-parse", "HEAD");
      cpSync(
        "test/fixtures/screenshots/option-page",
        join(repo, "design/auth/sign-in/options/bold"),
        {
          recursive: true,
        },
      );
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "head");
      const head = git(repo, "rev-parse", "HEAD");

      const out = join(scratch(), "options");
      const result = render([
        "--kind",
        "options",
        "--commit",
        head,
        "--root",
        repo,
        "--changed-since",
        base,
        "--out",
        out,
      ]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "1 option pages, 3 marked regions; manifest validated",
      );

      const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
      expect("manifest" in readScreenshotManifest(manifest, head, "options")).toBe(
        true,
      );
      const [option] = manifest.options;
      expect(option.option).toBe("bold");
      expect(option.path).toBe("design/auth/sign-in/options/bold");
      expect(option.width).toBe(1280);
      expect(
        option.regions.map((r: { component: string; variant: string | null }) => [
          r.component,
          r.variant,
        ]),
      ).toEqual([
        ["example-button", "Primary"],
        ["example-button", "Secondary"],
        ["example-card", null],
      ]);
      // The card is 300 wide plus 16 padding each side and a 1 pixel border each side.
      expect(option.regions[2].width).toBe(334);

      // Nothing changed under an options folder: no bundle and no failure.
      const none = join(scratch(), "none");
      const quiet = render([
        "--kind",
        "options",
        "--commit",
        head,
        "--root",
        repo,
        "--changed-since",
        head,
        "--out",
        none,
      ]);
      expect(quiet.status).toBe(0);
      expect(quiet.stdout).toContain("no option folders to render");
      expect(existsSync(none)).toBe(false);
    }, 120_000);

    it("renders every option folder at the head, unchanged ones and same names included, as head-options (D-281)", () => {
      const repo = scratch();
      git(repo, "init", "-q", "-b", "main");
      mkdirSync(join(repo, "design/billing/plans/options/bold"), { recursive: true });
      writeFileSync(
        join(repo, "design/billing/plans/options/bold/index.html"),
        "<p>approved earlier</p>\n",
      );
      cpSync(
        "test/fixtures/screenshots/option-page",
        join(repo, "design/auth/sign-in/options/bold"),
        { recursive: true },
      );
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "head");
      const head = git(repo, "rev-parse", "HEAD");

      const out = join(scratch(), "head-options");
      const args = ["--kind", "head-options", "--commit", head, "--root", repo];
      const result = render([...args, "--out", out]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "2 option pages, 3 marked regions; manifest validated",
      );
      const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
      expect("manifest" in readScreenshotManifest(manifest, head, "head-options")).toBe(
        true,
      );
      expect(manifest.options.map((o: { path: string }) => o.path)).toEqual([
        "design/auth/sign-in/options/bold",
        "design/billing/plans/options/bold",
      ]);

      // Rendered twice, the same commit gives the same pixels.
      const again = join(scratch(), "head-options");
      expect(render([...args, "--out", again]).status).toBe(0);
      const hashes = (dir: string) =>
        JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).options.map(
          (o: { sha256: string }) => o.sha256,
        );
      expect(hashes(again)).toEqual(hashes(out));

      const refused = render([
        ...args,
        "--changed-since",
        head,
        "--out",
        join(scratch(), "x"),
      ]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(
        "--changed-since applies to --kind options only",
      );
    }, 120_000);

    it("refuses a commit that is not the one checked out", () => {
      const result = render([
        "--kind",
        "gallery",
        "--commit",
        "0".repeat(40),
        "--out",
        join(scratch(), "x"),
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--commit is not the commit checked out");
    });
  },
);
