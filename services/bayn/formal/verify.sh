#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(dirname -- "$project_dir")"

if [[ $# -ne 0 ]]; then
  echo 'Usage: bun run --filter @proompteng/bayn verify:formal' >&2
  exit 2
fi
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Formal verification requires Linux with bubblewrap. Run this command in a Linux VM or container.' >&2
  exit 1
fi
for tool in lean bun bwrap git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Formal verification requires $tool on PATH." >&2
    exit 1
  fi
done

cd "$project_dir"
expected_version="$(cat lean-toolchain)"
expected_version="${expected_version#leanprover/lean4:v}"
case "$(lean --version)" in
  "Lean (version $expected_version,"*) ;;
  *)
    echo "Formal verification requires Lean $expected_version from lean-toolchain." >&2
    exit 1
    ;;
esac
lean_prefix="$(lean --print-prefix)"
"$lean_prefix/bin/lake" -q build
bash check.sh

export BAYN_FORMAL_EXECUTABLE="$project_dir/.lake/build/bin/bayn-model"
bun test "$service_dir/src/system-assessment/formal-conformance.test.ts"
