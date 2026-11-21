// Seam: the placeholder a new project's staging Worker serves (unit, D-438, O-160). The page
// shows the display name, the purpose and "being set up", each text escaped; the module, run here
// with only `Response` and `URL` in scope (its default export taken as is), answers `/api/health`
// exactly as the staging check's health probe requires and a JSON 404 for every other path. No
// network.
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  PLACEHOLDER_MODULE,
  PLACEHOLDER_PAGE_FILE,
  placeholderPage,
} from "./placeholder-site.ts";

/**
 * The module run as Cloudflare would call it: its default export's `fetch`, in a context that has
 * only `Response` and `URL`, so it needs nothing of Node's.
 */
function placeholderWorker(): { fetch(request: Request): Promise<Response> } {
  expect(PLACEHOLDER_MODULE.startsWith("export default {")).toBe(true);
  const context: { Response: typeof Response; URL: typeof URL; worker?: never } = {
    Response,
    URL,
  };
  runInNewContext(PLACEHOLDER_MODULE.replace(/^export default /, "worker = "), context);
  return context.worker as never;
}

describe("the placeholder site (unit, D-438, O-160)", () => {
  it('answers /api/health with exactly {"status":"ok"} and every other path with a JSON 404', async () => {
    const worker = placeholderWorker();
    const health = await worker.fetch(
      new Request("https://demo.didi.build/api/health"),
    );
    expect(health.status).toBe(200);
    expect(health.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await health.text()).toBe('{"status":"ok"}');
    for (const path of [
      "/api",
      "/api/",
      "/api/items",
      "/api/health/x",
      "/foreman-commit.txt",
      "/missing.png",
    ]) {
      const answer = await worker.fetch(new Request(`https://demo.didi.build${path}`));
      expect(answer.status, path).toBe(404);
      expect(await answer.json(), path).toEqual({ error: "not_found" });
    }
  });

  it("shows the display name, the purpose and that the project is being set up, escaped", () => {
    const page = placeholderPage(
      `Demo <script>alert("x")</script> & co`,
      "Tries 'things' out <b>quickly</b>.",
    );
    expect(PLACEHOLDER_PAGE_FILE).toBe("index.html");
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain(
      "<title>Demo &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</title>",
    );
    expect(page).toContain(
      "<h1>Demo &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</h1>",
    );
    expect(page).toContain(
      "<p>Tries &#39;things&#39; out &lt;b&gt;quickly&lt;/b&gt;.</p>",
    );
    expect(page).toContain("<p>This project is being set up.</p>");
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<b>");
    // No script of its own, and no commit marker: no commit built it.
    expect(page).not.toMatch(/<script|foreman-commit/);
  });

  it("escapes the five characters HTML gives a meaning to, and nothing else", () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;",
    );
    expect(escapeHtml("Démo, plain text: 100% ok")).toBe("Démo, plain text: 100% ok");
  });
});
