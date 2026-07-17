#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || "$1" != https://* ]]; then
  echo "Usage: ./xpi_gen.sh https://your-update-host.example/path" >&2
  exit 2
fi

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_directory"

node scripts/prepare-firefox-release.mjs \
  --base-url "$1" \
  --output web-ext-artifacts/release-source

(
  cd web-ext-artifacts/release-source
  zip -qr ../time-logger-unsigned.zip .
)

echo "Created web-ext-artifacts/time-logger-unsigned.zip"
echo "This archive still needs Mozilla signing before normal Firefox can install it."
