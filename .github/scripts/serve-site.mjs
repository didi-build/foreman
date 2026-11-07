// CI's preview check (D-354, O-111): a small static server for the built site, on 127.0.0.1
// only, with Node's built-in modules and nothing else. It serves the files under one folder,
// read-only, as the site's host does: a folder serves its `index.html`, and any other path with no
// file serves the root `index.html`, because the gallery is a single-page app
// (`not_found_handling: single-page-application` in wrangler.jsonc). No path outside the folder,
// and no dot-named file or folder, is ever served. It lives under `.github/`, a privileged path,
// so a pull request cannot change what the check does without Didi's approval.
//
// Usage: node .github/scripts/serve-site.mjs <site folder> <port>
// It prints one line once it listens and stops on SIGTERM or SIGINT. Port 0 picks a free port.
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The only address the server listens on. */
export const HOST = "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** The request handler for the site under `root`. */
export function siteHandler(root) {
  const base = resolve(root);
  const index = join(base, "index.html");
  return (request, response) => {
    const send = (status, body, type = "text/plain; charset=utf-8") => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (request.method !== "GET" && request.method !== "HEAD") return send(405, "");
    let path;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://site").pathname);
    } catch {
      return send(400, "");
    }
    const parts = path.split("/").filter((part) => part !== "");
    if (
      parts.some(
        (part) => part.startsWith(".") || part.includes("\\") || part.includes("\0"),
      )
    ) {
      return send(404, "");
    }
    let file = join(base, ...parts);
    if (file !== base && !file.startsWith(base + sep)) return send(404, "");
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
      return send(
        200,
        readFileSync(file),
        TYPES[extname(file)] ?? "application/octet-stream",
      );
    } catch {
      try {
        return send(200, readFileSync(index), TYPES[".html"]);
      } catch {
        return send(404, "");
      }
    }
  };
}

/** Starts the server for the site under `root` on `port` (0 for any free port). */
export function startSiteServer(root, port) {
  return new Promise((done, fail) => {
    const server = createServer(siteHandler(root));
    server.once("error", fail);
    server.listen(port, HOST, () => done(server));
  });
}

function fail(message) {
  console.error(`serve-site: ${message}`);
  process.exit(1);
}

async function main(args) {
  const [root, portText] = args;
  if (args.length !== 2 || !root || !portText)
    fail("usage: serve-site.mjs <site folder> <port>");
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
    fail("the site folder does not exist");
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535)
    fail("not a port number");
  let server;
  try {
    server = await startSiteServer(root, Number(portText));
  } catch {
    fail(`could not listen on ${HOST}:${portText}`);
  }
  console.log(`serve-site: serving on http://${HOST}:${server.address().port}`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
