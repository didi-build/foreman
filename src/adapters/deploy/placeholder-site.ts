// The placeholder a new project's staging Worker serves until the template's first build replaces
// it (D-438, ADR 0118 appendix C step 2, O-160): Foreman's own fixed site and tiny module, kept in
// the deploy adapter. Plain code with no network. It holds nothing from the project's repository:
// only the display name and purpose the New project form was given, escaped for HTML.
//
// - The module answers `/api/health` with 200 and exactly `{"status":"ok"}`, the template's own
//   answer (appendix E item 2), which the staging check's health probe also requires (O-159), so
//   `/api/health` reads the same before and after the first build. Any other path that reaches it
//   answers a JSON 404: other `/api/*` paths, and a request outside `/api` that matches no file and
//   is not a browser navigation (Cloudflare's SPA rule, O-159).
// - The page, `index.html`, shows the display name, the purpose and that the project is being set
//   up. With the runner's asset config, every navigation that matches no file is served it too.
//   It has no commit marker: no commit built it, so the staging check finds no deployed commit.

/** The module's source, uploaded as `index.js` (an ES module). */
export const PLACEHOLDER_MODULE = `export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health") return Response.json({ status: "ok" });
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
`;

/** The page's one file, at the site's root. */
export const PLACEHOLDER_PAGE_FILE = "index.html";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text made safe for an HTML element or a quoted attribute. */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);

/** The placeholder landing page for a project, its two texts escaped. */
export function placeholderPage(displayName: string, purpose: string): string {
  const name = escapeHtml(displayName);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
    <style>
      body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>${name}</h1>
      <p>${escapeHtml(purpose)}</p>
      <p>This project is being set up.</p>
    </main>
  </body>
</html>
`;
}
