#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
lean_prefix="$(lean --print-prefix)"
cd "$project_dir"
mkdir -p .lake
export_file="$(mktemp "$project_dir/.lake/bayn-export.XXXXXX")"
trap 'rm -f -- "$export_file"' EXIT

# Keep the export on disk: the pinned Lake stdout task can stall on a full pipe.
# Match its build/export isolation and retain all six sandboxed checker passes.
bwrap \
  --ro-bind / / \
  --tmpfs /home --tmpfs /root --tmpfs /run --tmpfs /var --tmpfs /tmp \
  --dir /tmp/home --dev /dev --proc /proc --clearenv \
  --ro-bind "$project_dir" "$project_dir" \
  --ro-bind "$lean_prefix" "$lean_prefix" \
  --bind "$project_dir/.lake" "$project_dir/.lake" \
  --setenv PATH "$lean_prefix/bin:$PATH" \
  --setenv HOME /tmp/home \
  --setenv LEAN_ABORT_ON_PANIC 1 --setenv LAKE_CHECK_EXPORT 1 \
  --unshare-all --die-with-parent --new-session --chdir "$project_dir" \
  -- "$lean_prefix/bin/lake" check > "$export_file"

"$lean_prefix/bin/lake" check --from-export "$export_file" --paranoid
