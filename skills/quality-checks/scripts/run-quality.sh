#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: run-quality.sh bumba" >&2
  exit 1
fi

TARGET="$1"
shift

if [[ "$TARGET" == "all" ]]; then
  bun run format
  bunx biome check .
else
  bun run --filter "$TARGET" lint || true
  bun run --filter "$TARGET" tsc || true
  bunx biome check "services/$TARGET" "packages/$TARGET" "apps/$TARGET" || true
fi
