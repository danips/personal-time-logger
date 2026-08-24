#!/usr/bin/env bash
set -euo pipefail

php "$(dirname "$0")/validator_test.php"
echo "Deterministic validator checks passed."
echo "For full endpoint integration, follow tests/README.md with a disposable MySQL 8.4 database."
