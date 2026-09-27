#!/usr/bin/env bash
set -euo pipefail
bun install --frozen-lockfile --ignore-scripts
trusted_output="$(NO_COLOR=1 FORCE_COLOR=0 bun pm ls --all --trusted)"
trusted_packages=()
{
  IFS= read -r header
  [[ "$header" == *' node_modules' ]] || { echo 'Unexpected Bun trusted-dependency header' >&2; exit 1; }
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    case "$line" in
      '├── '*|'└── '*) package="${line#* }" ;;
      *) echo "Unexpected Bun trusted-dependency entry: $line" >&2; exit 1 ;;
    esac
    if [[ ! "$package" =~ ^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@[0-9][0-9A-Za-z.+_-]*$ ]]; then
      echo "Invalid trusted package specification: $package" >&2
      exit 1
    fi
    trusted_packages+=("$package")
  done
} <<< "$trusted_output"
if (( ${#trusted_packages[@]} > 0 )); then
  npm rebuild --package-lock=false --foreground-scripts --ignore-scripts=false "${trusted_packages[@]}"
fi
bun install --frozen-lockfile --concurrent-scripts=1
