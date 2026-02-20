#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"

uv run python -m unittest \
  tests.test_market_context \
  tests.test_execution_adapters \
  tests.test_route_metadata \
  tests.test_metrics
