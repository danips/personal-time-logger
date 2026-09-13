# MySQL API integration tests

The repository includes a deterministic PHP validator test that does not need a
database:

```bash
bash tests/run.sh
```

When `pdo_mysql` is installed, the runner also executes the Session 1 checks if
both `PTL_TEST_MYSQL_DSN` and `PTL_TEST_MYSQL_ALLOW_RESET=1` are set. The
allow-reset flag is required because the test clears the configured database;
use only a disposable MySQL 8.4 database:

```bash
export PTL_TEST_MYSQL_DSN='mysql:host=127.0.0.1;port=3306;dbname=personal_time_logger_test;charset=utf8mb4'
export PTL_TEST_MYSQL_USER='personal_time_logger_test'
export PTL_TEST_MYSQL_PASSWORD='...'
export PTL_TEST_MYSQL_ALLOW_RESET=1
mysql --host=127.0.0.1 --user="$PTL_TEST_MYSQL_USER" --password="$PTL_TEST_MYSQL_PASSWORD" personal_time_logger_test < sql/001_initial_schema.sql
bash tests/run.sh
```

Install the schema before running the checks; the test user only needs access
to the already-created disposable schema and the test will clear its tables.

For endpoint integration, use a disposable MySQL 8.4 database and a temporary
config file outside `public/`:

```bash
mysql --host=127.0.0.1 --user=... --password ... personal_time_logger < sql/001_initial_schema.sql
PTL_MYSQL_API_CONFIG=/absolute/path/to/config.php php -S 127.0.0.1:8080 -t public public/index.php
```

Generate a token and its stored hash without committing either value:

```bash
TOKEN="$(php -r 'echo bin2hex(random_bytes(32));')"
HASH="$(PTL_TOKEN="$TOKEN" php -r 'echo hash("sha256", getenv("PTL_TOKEN"));')"
```

Exercise the API with the token in an environment variable:

```bash
export PTL_API_TOKEN="$TOKEN"
curl --fail-with-body -H "Authorization: Bearer $PTL_API_TOKEN" http://127.0.0.1:8080/v1/health
curl --fail-with-body -H "Authorization: Bearer $PTL_API_TOKEN" http://127.0.0.1:8080/v1/snapshot
```

The integration checklist is:

- health with and without a valid bearer token;
- malformed JSON and unsupported routes;
- append, identical repeat append, and conflicting append;
- snapshot round-trip of every canonical field;
- update and delete at the returned version, then stale retries;
- config insert, update, and stale update;
- change-token increments only for actual mutations;
- a multi-row mutation increments the change token once, not once per row;
- duplicate IDs in an update/delete/append batch are rejected before mutation;
- concurrent snapshot reads use one consistent database view;
- a multi-row request rolls back when a later item fails;
- SQL-like text remains data and never changes the query;
- empty `end_at` and `deleted_at` round-trip as `""`;
- response and server logs never contain the bearer token or raw SQL details.

## Disposable recovery drill

The extension's JSON backup and a MySQL server backup are different recovery
artifacts. The extension backup contains canonical local entries and selected
non-secret settings; it does not contain the MySQL schema, API configuration,
database credentials, or bearer token. A server backup is SQL produced from
the disposable MySQL database and must be stored outside the public web root
with the same care as database data.

Run this drill only against a positively identified disposable MySQL 8.4
database. Confirm the host, port, and database name before setting
`PTL_TEST_MYSQL_ALLOW_RESET=1`; that flag permits the integration test to clear
tables. From `server/mysql-api/`, a limited database user can create a clean
schema/data backup without requiring the `PROCESS` privilege for tablespaces:

```bash
backup_dir="$(mktemp -d /tmp/ptl-mysql-backup.XXXXXX)"
MYSQL_PWD="$PTL_TEST_MYSQL_PASSWORD" mysqldump \
  --host=127.0.0.1 --port=3307 --user="$PTL_TEST_MYSQL_USER" \
  --single-transaction --no-tablespaces personal_time_logger_test \
  > "$backup_dir/personal-time-logger.sql"
```

Restore only into a newly created disposable database using an administrative
database account, then inspect the target identity and run the API contract:

```bash
mysql --host=127.0.0.1 --port=3307 --user=... --password \
  --execute='CREATE DATABASE ptl_restore_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;'
mysql --host=127.0.0.1 --port=3307 --user=... --password \
  ptl_restore_test < "$backup_dir/personal-time-logger.sql"
PTL_TEST_MYSQL_DSN='mysql:host=127.0.0.1;port=3307;dbname=ptl_restore_test;charset=utf8mb4' \
PTL_TEST_MYSQL_USER=... PTL_TEST_MYSQL_PASSWORD=... \
PTL_TEST_MYSQL_ALLOW_RESET=1 bash tests/run.sh
```

The API configuration file remains outside `public/`. To replace a token,
generate a new random 32-byte value, store only its SHA-256 hex digest in the
configuration, restart the API, and update every extension device's local
token promptly. Verify that the new token receives `200` from `/v1/health` and
the old token receives `401`; this v1 setup intentionally has no dual-token
zero-downtime period. Do not put either raw token in shell history, logs, SQL
backups, or bug reports.

For schema upgrades, make a server backup first, inspect `sql/*.sql` in sorted
order, apply each new forward-only file once with an administrative account,
then run the deterministic and disposable endpoint checks above. The current
repository has only `001_initial_schema.sql` and no migration table or generic
migration framework; do not rerun an unreviewed initial schema against a
populated deployment or invent a second-version procedure before a real
migration exists. Remove the temporary database and backup after the drill.
