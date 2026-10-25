#!/usr/bin/env bash
set -euo pipefail
source_home="${1:?}"
persistent_home="${2:?}"
rsync -a --ignore-existing "$source_home/" "$persistent_home/"
rsync -a "$source_home/.codex/packages/standalone/" "$persistent_home/.codex/packages/standalone/"
rsync -a "$source_home/.local/bin/" "$persistent_home/.local/bin/"
