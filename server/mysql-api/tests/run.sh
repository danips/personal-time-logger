#!/usr/bin/env bash
set -euo pipefail

php "$(dirname "$0")/validator_test.php"
echo "Deterministic validator checks passed."
php "$(dirname "$0")/config_test.php"
echo "Deterministic config checks passed."
php "$(dirname "$0")/session1_integration_test.php"
echo "For full endpoint integration, follow tests/README.md with a disposable MySQL 8.4 database."
