// A stand-in for psql in test/admin-workflow-scripts.test.ts, for db-migrate.sh (O-115). It
// appends every call to the JSON lines file FAKE_PSQL_LOG: its arguments, every PG* setting in
// its environment and the script it read with `-f`, so a test can check a value reached the
// environment and never an argument. Nothing connects to a database.
//
// FAKE_PSQL_MODE=fresh answers as a fresh database would: `applying` and `applied` for each file
// the script would apply, then `done`. Otherwise it prints FAKE_PSQL_STDOUT (`done` when missing)
// and FAKE_PSQL_STDERR, and exits with FAKE_PSQL_STATUS (0 when missing).
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args[args.indexOf("-f") + 1];
const script = args.includes("-f") && file ? readFileSync(file, "utf8") : "";
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.startsWith("PG")),
);
appendFileSync(
  process.env.FAKE_PSQL_LOG ?? "/dev/null",
  `${JSON.stringify({ args, env, script })}\n`,
);

if (process.env.FAKE_PSQL_MODE === "fresh") {
  const names = [...script.matchAll(/^\\echo applying (\S+)$/gm)].map((m) => m[1]);
  process.stdout.write(
    [
      ...names.flatMap((name) => [`applying ${name}`, `applied ${name}`]),
      "done",
      "",
    ].join("\n"),
  );
} else {
  process.stdout.write(process.env.FAKE_PSQL_STDOUT ?? "done\n");
  process.stderr.write(process.env.FAKE_PSQL_STDERR ?? "");
  process.exitCode = Number(process.env.FAKE_PSQL_STATUS ?? "0");
}
