#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

output="${1:-time-logger.xpi}"
source_dir="web-ext-artifacts/local-package-source"

# Keep local review archives byte-for-byte aligned with the release source
# membership. The release source still gets its production update URL later in
# CI, after the release tag and configured GitHub Pages URL are known.
node scripts/prepare-firefox-release.mjs \
  --base-url "https://example.invalid/personal-time-logger" \
  --output "$source_dir"

rm -f "$output"
(
  cd "$source_dir"
  zip -q -r "$repo_root/$output" .
)

echo "Created $output"
