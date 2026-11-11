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
// FAKE_CURL_EXISTS_ANSWER: when set, `exists` (of a variable or a schedule) answers this text
// instead of true or false; a JSON array gives the answer of each `exists` call in turn (`null`
// keeps the true answer). An empty
// answer writes no `--output` file, as curl need not create one for an empty body.
// FAKE_CURL_EXIT: when set, every call fails as curl does when it cannot connect, with that exit
// code and no status. Any answer but `exists`'s repeats the request, as an API that echoes its
// input would (and `exists` too when FAKE_CURL_EXISTS_ANSWER is `echo`), and goes where `--output`
// says, or to stdout.
//
// It also plays Windmill's script and schedule routes for windmill-deploy.sh (D-371, O-123), as
// their handlers do in the same version (`windmill-api-scripts/src/scripts.rs`,
// `windmill-api-schedule/src/lib.rs`). The scripts are `<FAKE_CURL_LOG>.scripts` (path to its
// versions, newest last) and the schedules `<FAKE_CURL_LOG>.schedules` (path to the schedule).
// `POST .../scripts/create_snapshot` takes a multipart body (`--form`): the part `script` (the
// script's JSON) must come first and a part `file` (the bundle) must follow, or it answers 400.
// A path with no script gets its first version; a path with one needs `auto_parent` (or it answers
// 400, a path conflict), and with `?skip_if_noop=true` a script whose content, codebase, summary,
// description, language and job token scopes equal its newest version's adds none. Either way it
// answers 201. `GET .../schedules/exists/<path>` answers `true` or `false`; `POST
// .../schedules/create` adds the schedule (200), or answers 400 when the path exists; `POST
// .../schedules/update/<path>` changes its cron, time zone, arguments, cron version and
// description (200), never its script or whether it is enabled, or answers 500 when the path does
// not exist (the handler's `fetch_one` fails). Each call's `--form` parts are logged too: the
// script part's text, and the file part's sha256 and size.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const headers = [];
const files = [];
const form = [];
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
  } else if (arg === "--form" || arg === "-F") {
    // name=<file (the file's text as the part) or name=@file (the file itself), then ;type=...
    const [, name, kind, file, type] =
      /^([^=]+)=([<@])([^;]*)(?:;type=(.*))?$/.exec(next()) ?? [];
    const bytes = readFileSync(file);
    form.push(
      kind === "<"
        ? { name, kind, type, text: bytes.toString("utf8") }
        : {
            name,
            kind,
            type,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.length,
          },
    );
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
  `${JSON.stringify({ args, headerFiles: files, headers, method, url, body, stdin, form })}\n`,
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
/** The answer of an `exists` check, or the one FAKE_CURL_EXISTS_ANSWER gives in its place. */
const existsAnswer = (found) => {
  let given = process.env.FAKE_CURL_EXISTS_ANSWER;
  if (given?.startsWith("[")) {
    const checksBefore = readFileSync(process.env.FAKE_CURL_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(0, -1)
      .filter((line) =>
        /\/(variables|schedules)\/exists\//.test(JSON.parse(line).url ?? ""),
      ).length;
    given = JSON.parse(given)[checksBefore] ?? undefined;
  }
  if (given === "echo") return echo;
  return given ?? String(found);
};
if (route?.[1] === "exists/" && method === "GET") {
  status = "200";
  answer = existsAnswer(route[2] in variables);
} else if (route?.[1] === "create" && method === "POST") {
  const { path, value, is_secret, description } = JSON.parse(body);
  status = path in variables ? "400" : "201";
  change = () => (variables[path] = { value, is_secret, description });
} else if (route?.[1] === "update/" && method === "POST") {
  const path = route[2];
  status = path in variables ? "200" : "404";
  change = () => (variables[path] = { ...variables[path], ...JSON.parse(body) });
}

const scriptStore = `${process.env.FAKE_CURL_LOG}.scripts`;
const scripts = existsSync(scriptStore)
  ? JSON.parse(readFileSync(scriptStore, "utf8"))
  : {};
const scheduleStore = `${process.env.FAKE_CURL_LOG}.schedules`;
const schedules = existsSync(scheduleStore)
  ? JSON.parse(readFileSync(scheduleStore, "utf8"))
  : {};
const snapshot =
  /\/api\/w\/[^/]+\/scripts\/create_snapshot(\?skip_if_noop=true)?$/.exec(url ?? "");
const schedule = /\/api\/w\/[^/]+\/schedules\/(exists\/|create$|update\/)(.*)$/.exec(
  url ?? "",
);
const COMPARED = [
  "content",
  "codebase",
  "summary",
  "description",
  "language",
  "job_token_scopes",
];
if (snapshot && method === "POST") {
  const script = form[0]?.name === "script" ? JSON.parse(form[0].text) : undefined;
  const file = form.find((part) => part.name === "file");
  const versions = script ? (scripts[script.path] ?? []) : [];
  const head = versions.at(-1);
  if (script === undefined || file === undefined) {
    status = "400";
  } else if (head && script.auto_parent !== true) {
    status = "400";
  } else {
    status = "201";
    const noop =
      snapshot[1] !== undefined &&
      head !== undefined &&
      COMPARED.every(
        (key) => JSON.stringify(script[key]) === JSON.stringify(head[key]),
      );
    answer = String(noop ? head.hash : 1000 + versions.length);
    if (!noop) {
      change = () => {
        scripts[script.path] = [
          ...versions,
          { ...script, hash: 1000 + versions.length, bundle: file.sha256 },
        ];
        writeFileSync(scriptStore, JSON.stringify(scripts));
      };
    }
  }
} else if (schedule?.[1] === "exists/" && method === "GET") {
  status = "200";
  answer = existsAnswer(schedule[2] in schedules);
} else if (schedule?.[1] === "create" && method === "POST") {
  const created = JSON.parse(body);
  status = created.path in schedules ? "400" : "200";
  answer = created.path;
  change = () => {
    schedules[created.path] = created;
    writeFileSync(scheduleStore, JSON.stringify(schedules));
  };
} else if (schedule?.[1] === "update/" && method === "POST") {
  const path = schedule[2];
  status = path in schedules ? "200" : "500";
  answer = path;
  change = () => {
    const {
      schedule: cron,
      timezone,
      args: given,
      cron_version,
      description,
    } = JSON.parse(body);
    schedules[path] = {
      ...schedules[path],
      schedule: cron,
      timezone,
      args: given,
      cron_version,
      description,
    };
    writeFileSync(scheduleStore, JSON.stringify(schedules));
  };
}
const forced = (process.env.FAKE_CURL_STATUSES ?? "").split(" ").filter(Boolean)[count];
const natural = status;
if (forced !== undefined && forced !== "-") status = forced;
if (change && /^2/.test(natural) && /^2/.test(status)) {
  change();
  if (route) writeFileSync(store, JSON.stringify(variables));
}
if (!/^2/.test(status)) answer = echo;
if (output && answer !== "") writeFileSync(output, answer);
else process.stdout.write(answer);
process.stdout.write(writeOut.replace("%{http_code}", status));
