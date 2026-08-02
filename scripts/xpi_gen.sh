#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

output="${1:-time-logger.xpi}"

# Package all git-tracked files needed for the extension
git ls-files \
  | grep -v -e '^\.' -e '^scripts/' -e '^test/' -e '^package.json$' -e '\.md$' \
  | zip -q -@ "$output"

echo "Created $output"
