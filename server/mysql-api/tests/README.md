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
