// A stand-in for psql in test/admin-workflow-scripts.test.ts, for db-migrate.sh (O-115, O-118).
// It appends every call to the JSON lines file FAKE_PSQL_LOG: its arguments, every PG* setting in
// its environment, whether the file PGPASSFILE names exists, and the script it read with `-f`, so
// a test can check a value reached the environment and never an argument. Nothing connects to a
// database.
//
// A call without `-f` is the check that a connection without TLS is refused (O-118). It prints
// FAKE_PSQL_CHECK_STDERR and exits with FAKE_PSQL_CHECK_STATUS; when they are missing it answers
// as Supabase's docs show a refusal with SSL enforcement on: status 2 and "no pg_hba.conf entry
// for host ..., SSL off", quoting the host and the user it was given.
//
// A call with `-f` runs the migrations. FAKE_PSQL_MODE=fresh answers as a fresh database would:
// `applying` and `applied` for each file the script would apply, then `done`. Otherwise it prints
// FAKE_PSQL_STDOUT (`done` when missing) and FAKE_PSQL_STDERR, and exits with FAKE_PSQL_STATUS
// (0 when missing).
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args[args.indexOf("-f") + 1];
const script = args.includes("-f") && file ? readFileSync(file, "utf8") : "";
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.startsWith("PG")),
);
const passFileExists = env.PGPASSFILE ? existsSync(env.PGPASSFILE) : null;
appendFileSync(
  process.env.FAKE_PSQL_LOG ?? "/dev/null",
  `${JSON.stringify({ args, env, passFileExists, script })}\n`,
);

if (!args.includes("-f")) {
  const { PGHOST, PGPORT, PGUSER, PGDATABASE } = process.env;
  process.stderr.write(
    process.env.FAKE_PSQL_CHECK_STDERR ??
      `psql: error: connection to server at "${PGHOST}" (192.0.2.7), port ${PGPORT} failed: FATAL:  no pg_hba.conf entry for host "192.0.2.8", user "${PGUSER}", database "${PGDATABASE}", SSL off\n`,
  );
  process.exitCode = Number(process.env.FAKE_PSQL_CHECK_STATUS ?? "2");
  if (process.exitCode === 0) process.stdout.write("1\n");
} else if (process.env.FAKE_PSQL_MODE === "fresh") {
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
