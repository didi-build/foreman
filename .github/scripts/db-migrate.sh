#!/usr/bin/env bash
# Apply the database migrations not yet recorded (D-362, O-115). The Database migrations workflow
# (.github/workflows/db-migrate.yml) runs it in the environment `database`, once Didi approves,
# with MIGRATION_DATABASE_URL: the Supabase session pooler's connection string for the database
# owner. Usage: db-migrate.sh [migrations folder, db/migrations by default].
#
# Only protected code touches the credential (the pattern of D-358 lock 1): this script, redact.sh,
# bash, coreutils and psql read it, with the migration files and Supabase's CA certificate (a
# privileged path, O-118) and nothing else from the repository. npm, Node and the repository's
# TypeScript never run in the job. `npm run db:migrate`
# (src/adapters/store-postgres/migrate.ts) stays for local development and the tests.
#
# The same semantics as migrate.ts, so the two never disagree (test/db/db-migrate-script.test.ts
# runs both): the same advisory lock, the same setup of factory_meta.schema_migrations, a refusal
# when a recorded migration's file is missing or its SHA-256 differs from the file's, each pending
# file in name order in its own transaction together with its record row, and a stop at the first
# failure, which rolls that file back. The SHA-256 is of the file's bytes, which is migrate.ts's
# hash of the file's UTF-8 text for every valid UTF-8 file; a file that is not valid UTF-8 fails
# in the database (convert_from) before anything of it is recorded.
#
# One psql session reads one generated script, so the lock is held from the first statement to
# the last. Each file's text reaches the server as one query, exactly as migrate.ts's
# `client.query(sql)` sends it: the script carries it in base64 and `\gexec` sends the decoded
# text as it is, so psql never reads a backslash command or a variable in a migration. The script
# reads the recorded rows once, under the lock, before applying anything, as migrate.ts does.
#
# The connection string is never printed and never an argument. It is checked first (no space,
# newline or control character, then its shape), and masked before anything else prints, with
# its password, user and host, as written and percent-decoded. psql gets it parsed into PGHOST,
# PGPORT, PGUSER, PGPASSWORD and PGDATABASE in its own environment only, with no other PG*
# setting inherited, over TLS verified against Supabase's CA certificate in the checkout and the
# host name (verify-full, D-364, O-118). Before that, one connection without TLS and without any
# password checks that the database refuses it, so the run stops if Supabase's "Enforce SSL on
# incoming connections" is off. psql's own error lines are printed only through redact.sh, since
# a connection error can quote the host or the user. psql's normal output is read as fixed lines
# only; any other line stops the run without being shown.
set -euo pipefail
export LC_ALL=C
: "${RUNNER_TEMP:?}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations="${1:-db/migrations}"
report="${REPORT:-}"

# Supabase's root CA certificate, the file the services read (SUPABASE_CA_PATH in
# src/adapters/store-postgres/tls.ts), checked out with the migrations. psql trusts only it. The
# path is relative to the working directory, as db/migrations is: the workflow runs from the
# checkout's root. Nothing else names a CA: no variable or argument can change it.
ca_file="src/adapters/store-postgres/supabase-ca.crt"

# migrate.ts's MIGRATION_LOCK and its file name rule (test/admin-workflows.test.ts holds both).
lock_id=7104001
name_rule='^[0-9]{4}_[a-z0-9_]+\.sql$'

# migrate.ts's own setup, statement for statement (test/admin-workflows.test.ts compares them).
setup_sql='create schema if not exists factory_meta;
create table if not exists factory_meta.schema_migrations (
  name text primary key,
  sha256 text not null,
  applied_at timestamptz not null default now()
);
revoke all on schema factory_meta from public;'

applied=()
# Set once the database has refused a connection without TLS.
checked=""

# The job summary: migration names and fixed text only.
summary() {
  [ -n "$report" ] || return 0
  {
    echo "## Database migrations"
    echo
    if [ -n "$checked" ]; then
      echo "$checked"
      echo
    fi
    if [ "${#applied[@]}" -gt 0 ]; then
      echo "Applied, in order:"
      echo
      printf -- '- `%s`\n' "${applied[@]}"
      echo
    fi
    echo "$1"
  } >>"$report"
}

# Every refusal is fixed text that holds no value.
refuse() {
  summary "Stopped: $1"
  echo "::error::$1" >&2
  exit 1
}

# GitHub reads `%25`, `%0D` and `%0A` in a command's value as `%`, CR and LF (actions/runner,
# src/Runner.Common/ActionCommand.cs), so each `%` goes as `%25` and the value itself is masked.
mask() {
  echo "::add-mask::${1//%/%25}"
}

# The user and the password as libpq reads them: each %XX is the byte XX. A % not followed by two
# hex digits, or one that encodes a control character, is refused. The result is in $decoded.
decoded=""
percent_decode() {
  local in="$1" i=0 hex byte
  decoded=""
  while [ "$i" -lt "${#in}" ]; do
    if [ "${in:i:1}" = "%" ]; then
      hex="${in:i+1:2}"
      if ! [[ "$hex" =~ ^[0-9A-Fa-f]{2}$ ]] || ((16#$hex < 32 || 16#$hex == 127)); then
        return 1
      fi
      printf -v byte '%b' "\\x$hex"
      decoded+="$byte"
      i=$((i + 3))
    else
      decoded+="${in:i:1}"
      i=$((i + 1))
    fi
  done
}

# One or more PEM certificates and nothing else, as readDatabaseCa in tls.ts reads the file: each
# block's lines are base64 that decodes. libpq reads the certificates itself and fails on one it
# cannot use; this makes a missing or wrong file a fixed refusal before anything connects.
is_pem_certificates() {
  local line inside=false body="" blocks=0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [ "$inside" = false ]; then
      if [ "$line" = "-----BEGIN CERTIFICATE-----" ]; then
        inside=true
        body=""
      elif ! [[ "$line" =~ ^[[:space:]]*$ ]]; then
        return 1
      fi
    elif [ "$line" = "-----END CERTIFICATE-----" ]; then
      [ -n "$body" ] || return 1
      printf '%s' "$body" | base64 -d >/dev/null 2>&1 || return 1
      inside=false
      blocks=$((blocks + 1))
    elif [[ "$line" =~ ^[A-Za-z0-9+/=]+$ ]]; then
      body+="$line"
    else
      return 1
    fi
  done <"$1"
  [ "$inside" = false ] && [ "$blocks" -gt 0 ]
}

# The connection string: checked, then masked, before anything else prints.
url="${MIGRATION_DATABASE_URL:-}"
if [ -z "$url" ]; then
  refuse "MIGRATION_DATABASE_URL is not set in the database environment (first-hosting runbook step 9a)."
fi
if [[ "$url" =~ [[:space:][:cntrl:]] ]]; then
  refuse "MIGRATION_DATABASE_URL holds a space, a newline or a control character: paste it again (first-hosting runbook step 9a)."
fi
mask "$url"
shape='^postgres(ql)?://([^:@/?#]+):([^@/?#]+)@([A-Za-z0-9.-]+)(:([0-9]{1,5}))?/([A-Za-z0-9_-]+)$'
if ! [[ "$url" =~ $shape ]]; then
  refuse "MIGRATION_DATABASE_URL is not postgresql://user:password@host:port/database with nothing after the database name, as Supabase's session pooler gives it (first-hosting runbook step 9a). An @, /, ?, # or % in the password must be percent-encoded."
fi
user_encoded="${BASH_REMATCH[2]}"
password_encoded="${BASH_REMATCH[3]}"
host="${BASH_REMATCH[4]}"
port="${BASH_REMATCH[6]:-5432}"
database="${BASH_REMATCH[7]}"
mask "$password_encoded"
mask "$user_encoded"
mask "$host"
if ! percent_decode "$password_encoded"; then
  refuse "The password in MIGRATION_DATABASE_URL holds a % that is not followed by two hex digits, or that encodes a control character (first-hosting runbook step 9a)."
fi
password="$decoded"
if ! percent_decode "$user_encoded"; then
  refuse "The user in MIGRATION_DATABASE_URL holds a % that is not followed by two hex digits, or that encodes a control character (first-hosting runbook step 9a)."
fi
user="$decoded"
[ "$password" = "$password_encoded" ] || mask "$password"
[ "$user" = "$user_encoded" ] || mask "$user"
if ((10#$port < 1 || 10#$port > 65535)); then
  refuse "The port in MIGRATION_DATABASE_URL is not between 1 and 65535 (first-hosting runbook step 9a)."
fi

# The CA certificate, before anything connects, refused in tls.ts's words (tls.ts also checks
# that each certificate is a CA, which bash cannot read; libpq then decides what it trusts).
if [ ! -f "$ca_file" ]; then
  refuse "The database CA certificate is missing at $ca_file."
fi
if ! is_pem_certificates "$ca_file"; then
  refuse "The database CA certificate at $ca_file is not a PEM certificate."
fi

# The migration files, in name order, as migrate.ts's readMigrations picks them.
if [ ! -d "$migrations" ]; then
  refuse "The migrations folder $migrations is missing."
fi
names=()
paths=()
shas=()
for path in "$migrations"/*; do
  name="${path##*/}"
  [[ "$name" =~ $name_rule ]] || continue
  if [ ! -f "$path" ]; then
    refuse "$name in $migrations is not a file."
  fi
  read -r sha _ < <(sha256sum <"$path")
  names+=("$name")
  paths+=("$path")
  shas+=("$sha")
done

umask 077
work="$(mktemp -d "$RUNNER_TEMP/db-migrate.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# One query, sent to the server as one piece of text by \gexec (see the header).
as_one_query() {
  echo "select convert_from(decode('$(base64 -w 0)', 'base64'), 'UTF8') \\gexec"
}

files_array="array[]::text[]"
if [ "${#names[@]}" -gt 0 ]; then
  files_array="array['$(
    IFS=,
    echo "${names[*]}" | sed "s/,/', '/g"
  )']::text[]"
fi

{
  echo '\set ON_ERROR_STOP on'
  echo '\set AUTOCOMMIT on'
  echo '\set ON_ERROR_ROLLBACK off'
  # Query results and command tags go nowhere; only the \echo lines below reach stdout.
  echo '\o /dev/null'
  echo "select pg_advisory_lock($lock_id);"
  printf '%s' "$setup_sql" | as_one_query
  # The recorded rows, read once in one statement before anything is applied.
  echo "select"
  echo "  exists (select from factory_meta.schema_migrations where not (name = any ($files_array))) as missing,"
  echo "  coalesce((select case when name ~ '^[0-9]{4}_[a-z0-9_]+[.]sql\$' then name else '-' end from factory_meta.schema_migrations where not (name = any ($files_array)) order by name collate \"C\" limit 1), '-') as missing_name"
  for i in "${!names[@]}"; do
    echo "  , not exists (select from factory_meta.schema_migrations where name = '${names[i]}') as pending_$i"
    echo "  , exists (select from factory_meta.schema_migrations where name = '${names[i]}' and sha256 <> '${shas[i]}') as changed_$i"
  done
  echo '\gset'
  echo '\if :missing'
  echo "select pg_advisory_unlock($lock_id);"
  echo '\echo missing :missing_name'
  echo '\q'
  echo '\endif'
  for i in "${!names[@]}"; do
    echo "\\if :changed_$i"
    echo "select pg_advisory_unlock($lock_id);"
    echo "\\echo changed ${names[i]}"
    echo '\q'
    echo '\endif'
    echo "\\if :pending_$i"
    echo "\\echo applying ${names[i]}"
    echo 'begin;'
    as_one_query <"${paths[i]}"
    echo "insert into factory_meta.schema_migrations (name, sha256) values ('${names[i]}', '${shas[i]}');"
    echo 'commit;'
    echo "\\echo applied ${names[i]}"
    echo '\endif'
  done
  echo "select pg_advisory_unlock($lock_id);"
  echo '\echo done'
} >"$work/migrate.psql"

# psql's error lines from the file named, with the connection's values and any id or address
# replaced.
show_psql_errors() {
  REDACT_NAMES="MIGRATION_DATABASE_URL,DATABASE_PASSWORD,DATABASE_PASSWORD_ENCODED,DATABASE_USER,DATABASE_USER_ENCODED,DATABASE_HOST" \
    MIGRATION_DATABASE_URL="$url" DATABASE_PASSWORD_ENCODED="$password_encoded" \
    DATABASE_PASSWORD="$password" DATABASE_USER_ENCODED="$user_encoded" DATABASE_USER="$user" \
    DATABASE_HOST="$host" "$here/redact.sh" <"$1" >&2
}

# Only psql's environment holds the connection settings, and no inherited PG* setting is kept.
while IFS= read -r inherited; do
  unset "$inherited"
done < <(compgen -e PG || true)

# First, the database must refuse a connection without TLS (D-364, O-118). This connection has
# TLS and GSSAPI encryption off, no password in its environment, a password file that does not
# exist, and -w, so psql never sends a password, whatever the server asks. It passes only when
# psql fails to connect (status 2) because the server refuses a connection with no encryption,
# and no other server error comes with it. Supabase's session pooler (Supavisor) words that
# refusal "(ESSLREQUIRED) SSL connection is required for user: <user>" (its
# lib/supavisor/errors/ssl_required_error.ex, read 2026-11-08); Postgres's own pg_hba.conf
# check, met on a direct connection, words it "SSL off" (Supabase's docs) or "no encryption"
# (PostgreSQL 16). If the server asks for a password or lets it in, enforcement is off. Any other
# answer stops the run too.
check_status=0
PGHOST="$host" PGPORT="$port" PGUSER="$user" PGDATABASE="$database" \
  PGPASSFILE="$work/no-password-file" PGSSLMODE=disable PGGSSENCMODE=disable \
  PGCONNECT_TIMEOUT=30 PGAPPNAME=foreman-db-migrate-tls-check \
  psql -X -q -w -c "select 1" >/dev/null 2>"$work/check-err" </dev/null || check_status=$?
refused_rule='FATAL:  (\(ESSLREQUIRED\) SSL connection is required for user: [^[:space:]]+|no pg_hba\.conf entry for host "[^"]*", user "[^"]*", database "[^"]*", (SSL off|no encryption))$'
refused=false
asked_for_password=false
other_server_error=false
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" == *"no password supplied"* ]]; then
    asked_for_password=true
  elif [[ "$line" =~ $refused_rule ]]; then
    refused=true
  elif [[ "$line" == *"FATAL:"* || "$line" == *"ERROR:"* ]]; then
    other_server_error=true
  fi
done <"$work/check-err"
enforcement_off="Supabase's \"Enforce SSL on incoming connections\" is off"
if [ "$check_status" -eq 0 ]; then
  show_psql_errors "$work/check-err"
  refuse "$enforcement_off: the database let in a connection without TLS. Turn it on (first-hosting runbook step 9a), then run this job again. Nothing was applied."
fi
if [ "$asked_for_password" = true ]; then
  show_psql_errors "$work/check-err"
  refuse "$enforcement_off: the database asked a connection without TLS for a password, and none was sent. Turn it on (first-hosting runbook step 9a), then run this job again. Nothing was applied."
fi
if [ "$check_status" -ne 2 ] || [ "$refused" != true ] || [ "$other_server_error" = true ]; then
  show_psql_errors "$work/check-err"
  refuse "The check that the database refuses a connection without TLS did not end in the refusal it expects, so nothing was applied. psql's error, redacted, is above (first-hosting runbook step 9a)."
fi
checked="Checked first: the database refuses a connection without TLS."
echo "$checked"

# Then the migrations, over TLS verified against the CA certificate and the host name. GSSAPI
# encryption is off, so TLS is the only encryption libpq may use.
status=0
PGHOST="$host" PGPORT="$port" PGUSER="$user" PGPASSWORD="$password" PGDATABASE="$database" \
  PGSSLMODE=verify-full PGSSLROOTCERT="$ca_file" PGGSSENCMODE=disable \
  PGCLIENTENCODING=UTF8 PGCONNECT_TIMEOUT=30 PGAPPNAME=foreman-db-migrate \
  psql -X -q -w --set=ON_ERROR_STOP=1 -f "$work/migrate.psql" \
  >"$work/out" 2>"$work/err" </dev/null || status=$?

print_applied() {
  if [ "${#applied[@]}" -gt 0 ]; then
    echo "Applied: $(
      IFS=,
      echo "${applied[*]}" | sed 's/,/, /g'
    )"
  fi
}

applying=""
refusal=""
finished=false
while IFS= read -r line; do
  if [[ "$line" =~ ^applying\ ([0-9]{4}_[a-z0-9_]+\.sql)$ ]] && [ -z "$applying" ]; then
    applying="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^applied\ ([0-9]{4}_[a-z0-9_]+\.sql)$ ]] && [ "${BASH_REMATCH[1]}" = "$applying" ]; then
    applied+=("$applying")
    applying=""
  elif [[ "$line" =~ ^missing\ ([0-9]{4}_[a-z0-9_]+\.sql)$ ]]; then
    refusal="${BASH_REMATCH[1]} is recorded as applied but its file is missing."
  elif [ "$line" = "missing -" ]; then
    refusal="A row whose name is not a migration file name is recorded as applied, and no file has that name."
  elif [[ "$line" =~ ^changed\ ([0-9]{4}_[a-z0-9_]+\.sql)$ ]]; then
    refusal="${BASH_REMATCH[1]} changed after it was applied. Add a new migration instead of editing it."
  elif [ "$line" = "done" ] && [ -z "$applying" ]; then
    finished=true
  else
    print_applied
    refuse "psql printed a line this script does not expect, so the run stopped. The line is not shown, since it could hold a value."
  fi
done <"$work/out"

print_applied
if [ -n "$refusal" ] && [ "$status" -eq 0 ]; then
  refuse "$refusal"
fi
if [ "$status" -ne 0 ] || [ "$finished" != true ]; then
  show_psql_errors "$work/err"
  if [ -n "$applying" ]; then
    refuse "$applying failed and was rolled back; nothing after it was applied. psql's error, redacted, is above."
  fi
  refuse "psql stopped (exit status $status) before the end, with nothing more applied. psql's error, redacted, is above."
fi
if [ "${#applied[@]}" -eq 0 ]; then
  echo "Nothing to apply."
  summary "Nothing to apply: every migration is recorded."
else
  summary "Every migration is recorded."
fi
