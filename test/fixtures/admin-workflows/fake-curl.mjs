// A stand-in for curl in test/admin-workflow-scripts.test.ts, playing Windmill's API. It appends
// every call to the JSON lines file FAKE_CURL_LOG: its arguments, the headers it read from
// `--header @<file>` files (kept apart from the arguments) and the body it read from stdin, so a
// test can check a secret reached a file or stdin and never an argument. Nothing leaves the
// machine.
//
// FAKE_CURL_STATUSES: the HTTP status of each call in turn, space-separated (201 when missing).
// FAKE_CURL_EXIT: when set, every call fails as curl does when it cannot connect, with that exit
// code and no status. The answer's body repeats the request, as an API that echoes its input
// would, and goes where `--output` says, or to stdout.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const headers = [];
const files = [];
let body = "";
let output;
let writeOut = "";
let method = "GET";
let url;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = () => args[++i];
  if (arg === "--header" || arg === "-H") {
    const value = next();
    if (value.startsWith("@")) {
      files.push(value.slice(1));
      headers.push(...readFileSync(value.slice(1), "utf8").split("\n").filter(Boolean));
    } else {
      headers.push(value);
    }
  } else if (arg === "--data-binary") {
    const value = next();
    body = value === "@-" ? readFileSync(0, "utf8") : value;
    method = method === "GET" ? "POST" : method;
  } else if (arg === "--request" || arg === "-X") {
    method = next();
  } else if (arg === "--output" || arg === "-o") {
    output = next();
  } else if (arg === "--write-out" || arg === "-w") {
    writeOut = next();
  } else if (arg === "--proto" || arg === "--max-time") {
    next();
  } else if (!arg.startsWith("-")) {
    url = arg;
  }
}

const counter = `${process.env.FAKE_CURL_LOG}.count`;
const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(count + 1));
appendFileSync(
  process.env.FAKE_CURL_LOG,
  `${JSON.stringify({ args, headerFiles: files, headers, method, url, body })}\n`,
);

if (process.env.FAKE_CURL_EXIT) {
  process.stderr.write("curl: (7) Failed to connect to the host: Connection refused\n");
  process.stdout.write(writeOut.replace("%{http_code}", "000"));
  process.exit(Number(process.env.FAKE_CURL_EXIT));
}
const statuses = (process.env.FAKE_CURL_STATUSES ?? "").split(" ").filter(Boolean);
const status = statuses[count] ?? "201";
const answer = JSON.stringify({ status, echo: { headers, body } });
if (output) writeFileSync(output, answer);
else process.stdout.write(answer);
process.stdout.write(writeOut.replace("%{http_code}", status));
