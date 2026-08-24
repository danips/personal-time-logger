# Personal Time Logger MySQL 8.4 API

This directory contains the server-side HTTPS JSON API for the MySQL remote
storage provider. The Firefox extension never connects to MySQL directly and
never receives the database username or password.

## Deployment

The target deployment is MySQL 8.4 with global PHP 8.5. The implementation uses
PHP 8.2+ syntax, PDO MySQL, and no framework or Composer runtime dependency.

1. Create a dedicated database and a dedicated API database user. Grant the
   user only the required rights on this database (`SELECT`, `INSERT`,
   `UPDATE`, and `DELETE`); run schema installation with an administrative
   account if your hosting separates those privileges.
2. Run [`sql/001_initial_schema.sql`](sql/001_initial_schema.sql).
3. Copy [`config.example.php`](config.example.php) to `config.php` outside the
   public web root. Set `PTL_MYSQL_API_CONFIG` to its absolute path, or place
   it at `server/mysql-api/config.php` while ensuring the web server cannot
   serve that file.
4. Generate a 32-byte random token and store only its SHA-256 hex digest in
   `api_token_sha256`. Put the raw token only in the extension’s device-local
   settings.
5. Set `cors_origins` to the exact extension origin(s) that need access. Do not
   use `*` with bearer credentials.
6. Serve `public/` behind HTTPS. The API should be reachable at one stable
   origin such as `https://time-api.example.com/`.
7. Test `/v1/health` with the bearer token before configuring the extension.

On Apache/PHP hosting, deploy the included `public/.htaccess` unchanged. It
forwards the `Authorization` header to PHP, which some CGI/FastCGI setups omit
by default. The PHP handler also checks the standard request-header fallback.

The public document root should be this directory’s `public/` directory. The
database configuration and token hash must remain outside that directory.

## HTTP contract

All routes require `Authorization: Bearer <token>`:

```text
GET  /v1/health
GET  /v1/change-token
GET  /v1/snapshot
POST /v1/entries/append
POST /v1/entries/update
POST /v1/entries/delete
POST /v1/config/update
```

Application errors use this shape and never expose PDO or SQL details:

```json
{
  "error": {
    "code": "REMOTE_VERSION_STALE",
    "message": "The remote entry changed before the update."
  }
}
```

Entry mutations use `remote_version` fences. Appends are idempotent for an
identical canonical entry and return `409 REMOTE_APPEND_CONFLICT` for the same
ID with different content. Successful physical entry/config mutations bump
`app_meta.change_seq` in the same transaction.

## Local verification

Run the deterministic checks with:

```bash
bash tests/run.sh
```

See [`tests/README.md`](tests/README.md) for disposable-database endpoint
testing instructions.
