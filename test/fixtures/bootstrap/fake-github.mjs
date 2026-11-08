// Test double for the Bootstrap scripts' subprocess tests, loaded with `node --import`: it
// replaces fetch with canned GitHub answers, so nothing reaches the network. FAKE_GITHUB_ANSWERS
// names a JSON file mapping "METHOD /path" to {status, body} or {noAnswer: true}; a request with
// no answer gets 404. Each request is appended to the file FAKE_GITHUB_LOG names.
import { appendFileSync, readFileSync } from "node:fs";

const answersPath = process.env.FAKE_GITHUB_ANSWERS;
const logPath = process.env.FAKE_GITHUB_LOG;
const answers = answersPath ? JSON.parse(readFileSync(answersPath, "utf8")) : {};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  const key = `${method} ${url.pathname}`;
  if (logPath) {
    appendFileSync(
      logPath,
      `${JSON.stringify({
        key,
        url: url.href,
        headers: init.headers ?? {},
        body: init.body ?? null,
        redirect: init.redirect ?? null,
      })}\n`,
    );
  }
  const answer = answers[key];
  if (!answer) {
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }
  if (answer.noAnswer) {
    throw new TypeError("fetch failed");
  }
  return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
    status: answer.status,
  });
};
