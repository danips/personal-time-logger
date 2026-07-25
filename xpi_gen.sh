#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

output="${1:-time-logger.xpi}"

# Package all git-tracked files needed for the extension
git ls-files \
  | grep -v -e '^\.' -e '^scripts/' -e '\.md$' -e '^xpi_gen.sh$' \
  | zip -q -@ "$output"

echo "Created $output"
