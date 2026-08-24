# MySQL API integration tests

The repository includes a deterministic PHP validator test that does not need a
database:

```bash
bash tests/run.sh
```

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
- a multi-row request rolls back when a later item fails;
- SQL-like text remains data and never changes the query;
- empty `end_at` and `deleted_at` round-trip as `""`;
- response and server logs never contain the bearer token or raw SQL details.
