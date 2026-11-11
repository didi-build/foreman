// A stand-in for curl in test/admin-workflow-scripts.test.ts, playing Windmill's variables API
// (D-370, O-120). It appends every call to the JSON lines file FAKE_CURL_LOG: its arguments, the
// headers it read from `--header @<file>` files (kept apart from the arguments), its stdin and the
// body it read from stdin, so a test can check a secret reached a file or stdin and never an
// argument. Nothing leaves the machine.
//
// The variables Windmill holds are the JSON file `<FAKE_CURL_LOG>.variables` (path to
// `{value, is_secret, description}`; none when it is missing), which a test may write first. As
// Windmill's own handlers do (`windmill-store/src/variables.rs`, v1.865.0):
// `GET .../variables/exists/<path>` answers `true` or `false` (200); `POST .../variables/create`
// adds the body's variable (201), or answers 400 when the path exists; `POST
// .../variables/update/<path>` changes the fields its body names (200), or answers 404 when the
// path does not exist.
//
// FAKE_CURL_STATUSES: the HTTP status of each call in turn, space-separated, in place of the one
// above (`-` or a missing entry keeps it); a call answered with anything but 2xx changes nothing.
// FAKE_CURL_EXISTS_ANSWER: when set, `exists` answers this text instead of true or false; a JSON
// array gives the answer of each `exists` call in turn (`null` keeps the true answer). An empty
// answer writes no `--output` file, as curl need not create one for an empty body.
// FAKE_CURL_EXIT: when set, every call fails as curl does when it cannot connect, with that exit
// code and no status. Any answer but `exists`'s repeats the request, as an API that echoes its
// input would (and `exists` too when FAKE_CURL_EXISTS_ANSWER is `echo`), and goes where `--output`
// says, or to stdout.
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
// What a call without a body would have found on stdin, so a test can check none was there.
const stdin = body === "" ? readFileSync(0, "utf8") : undefined;

const counter = `${process.env.FAKE_CURL_LOG}.count`;
const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(count + 1));
appendFileSync(
  process.env.FAKE_CURL_LOG,
  `${JSON.stringify({ args, headerFiles: files, headers, method, url, body, stdin })}\n`,
);

if (process.env.FAKE_CURL_EXIT) {
  process.stderr.write("curl: (7) Failed to connect to the host: Connection refused\n");
  process.stdout.write(writeOut.replace("%{http_code}", "000"));
  process.exit(Number(process.env.FAKE_CURL_EXIT));
}

const store = `${process.env.FAKE_CURL_LOG}.variables`;
const variables = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {};
const route = /\/api\/w\/[^/]+\/variables\/(exists\/|create$|update\/)(.*)$/.exec(
  url ?? "",
);
const echo = JSON.stringify({ echo: { headers, body } });
let status = "404";
let answer = echo;
let change;
if (route?.[1] === "exists/" && method === "GET") {
  status = "200";
  answer = String(route[2] in variables);
  let given = process.env.FAKE_CURL_EXISTS_ANSWER;
  if (given?.startsWith("[")) {
    const checksBefore = readFileSync(process.env.FAKE_CURL_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(0, -1)
      .filter((line) =>
        /\/variables\/exists\//.test(JSON.parse(line).url ?? ""),
      ).length;
    given = JSON.parse(given)[checksBefore] ?? undefined;
  }
  if (given === "echo") answer = echo;
  else if (given !== undefined) answer = given;
} else if (route?.[1] === "create" && method === "POST") {
  const { path, value, is_secret, description } = JSON.parse(body);
  status = path in variables ? "400" : "201";
  change = () => (variables[path] = { value, is_secret, description });
} else if (route?.[1] === "update/" && method === "POST") {
  const path = route[2];
  status = path in variables ? "200" : "404";
  change = () => (variables[path] = { ...variables[path], ...JSON.parse(body) });
}
const forced = (process.env.FAKE_CURL_STATUSES ?? "").split(" ").filter(Boolean)[count];
const natural = status;
if (forced !== undefined && forced !== "-") status = forced;
if (change && /^2/.test(natural) && /^2/.test(status)) {
  change();
  writeFileSync(store, JSON.stringify(variables));
}
if (!/^2/.test(status)) answer = echo;
if (output && answer !== "") writeFileSync(output, answer);
else process.stdout.write(answer);
process.stdout.write(writeOut.replace("%{http_code}", status));
