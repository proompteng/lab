#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
lean_prefix="$(lean --print-prefix)"
cd "$project_dir"
mkdir -p .lake
export_file="$(mktemp "$project_dir/.lake/bayn-export.XXXXXX")"
sources_file="$(mktemp "$project_dir/.lake/bayn-sources.XXXXXX")"
scope_file="$project_dir/.lake/bayn-proof-scope.json"
trap 'rm -f -- "$export_file" "$sources_file"' EXIT
rm -f -- "$scope_file"

# Every tracked model module is a root, including modules with namespaces outside Bayn.
# Export.lean is the exporter driver itself, not part of the model being checked.
git ls-files -z -- '*.lean' ':!:Export.lean' > "$sources_file"
modules=()
targets=()
while IFS= read -r -d '' source; do
  module="${source%.lean}"
  module="${module//\//.}"
  modules+=("$module")
  targets+=("+$module")
done < "$sources_file"
if [[ ${#modules[@]} -eq 0 ]]; then
  echo 'No tracked Lean model modules to verify.' >&2
  exit 1
fi

# Keep the export on disk: the pinned Lake stdout task can stall on a full pipe.
# Match its build/export isolation and retain all six sandboxed checker passes.
sandbox=(
  --ro-bind / /
  --tmpfs /home --tmpfs /root --tmpfs /run --tmpfs /var --tmpfs /tmp
  --dir /tmp/home --dev /dev --proc /proc --clearenv
  --ro-bind "$project_dir" "$project_dir"
  --ro-bind "$lean_prefix" "$lean_prefix"
  --bind "$project_dir/.lake" "$project_dir/.lake"
  --setenv PATH "$lean_prefix/bin:$PATH"
  --setenv HOME /tmp/home
  --setenv LEAN_ABORT_ON_PANIC 1
  --unshare-all --die-with-parent --new-session --chdir "$project_dir"
)
# Build every owned module before importing it, including any root outside the default target graph.
bwrap "${sandbox[@]}" -- "$lean_prefix/bin/lake" build "${targets[@]}"
bwrap "${sandbox[@]}" -- "$lean_prefix/bin/lake" env lean --run Export.lean "$scope_file" "${modules[@]}" > "$export_file"

"$lean_prefix/bin/lake" check --from-export "$export_file" --paranoid
