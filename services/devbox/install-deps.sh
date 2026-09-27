#!/usr/bin/env bash
set -euo pipefail
bun install --frozen-lockfile --ignore-scripts
bun install --frozen-lockfile --force --concurrent-scripts=1
