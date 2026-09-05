#!/usr/bin/env bash
set -euo pipefail

php "$(dirname "$0")/validator_test.php"
echo "Deterministic validator checks passed."
php "$(dirname "$0")/config_test.php"
echo "Deterministic config checks passed."
php "$(dirname "$0")/session1_integration_test.php"
if [[ -n "${PTL_TEST_MYSQL_DSN:-}" && "${PTL_TEST_MYSQL_ALLOW_RESET:-}" == "1" ]]; then
  test_dir="$(cd "$(dirname "$0")" && pwd)"
  api_dir="$(dirname "$test_dir")"
  repo_dir="$(dirname "$(dirname "$api_dir")")"
  port="${PTL_TEST_MYSQL_HTTP_PORT:-18765}"
  export PTL_TEST_HTTP_TOKEN="synthetic-mysql-http-contract-token"
  export PTL_MYSQL_API_CONFIG="$test_dir/http_config.php"
  log_file="$(mktemp)"
  php -S "127.0.0.1:$port" -t "$api_dir/public" "$api_dir/public/index.php" >"$log_file" 2>&1 &
  server_pid=$!
  trap 'kill "$server_pid" 2>/dev/null || true; rm -f "$log_file"' EXIT
  for _ in {1..50}; do
    if curl --silent --output /dev/null "http://127.0.0.1:$port/v1/health"; then break; fi
    sleep 0.1
  done
  node "$repo_dir/server/http-contract.mjs" "http://127.0.0.1:$port" "$PTL_TEST_HTTP_TOKEN"
  kill "$server_pid"
  wait "$server_pid" 2>/dev/null || true
  rm -f "$log_file"
  trap - EXIT
fi
echo "For full endpoint integration, follow tests/README.md with a disposable MySQL 8.4 database."
