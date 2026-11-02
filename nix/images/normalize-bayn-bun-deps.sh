#!/usr/bin/env bash
set -euo pipefail

closure="${1:?Bayn dependency closure is required}"
test -d "${closure}/node_modules/.bun"
shopt -s nullglob

# Bun's isolated installer can omit either CLI link in the browserslist/update-db
# dependency cycle. Preserve package bytes and make both valid layouts identical
# before Nix checks the fixed-output hash. Unexpected links or missing targets fail.
ensure_cli_link() {
  local modules="$1"
  local command="$2"
  local target="../${command}/cli.js"
  local link="${modules}/.bin/${command}"
  if [[ ! -f "${modules}/${command}/cli.js" ]]; then
    printf 'Missing locked CLI target: %s\n' "${modules}/${command}/cli.js" >&2
    return 1
  fi
  mkdir -p "${modules}/.bin"
  if [[ -L "${link}" ]]; then
    if [[ "$(readlink "${link}")" != "${target}" ]]; then
      printf 'Unexpected existing CLI link: %s\n' "${link}" >&2
      return 1
    fi
  elif [[ -e "${link}" ]]; then
    printf 'CLI link path is not a symlink: %s\n' "${link}" >&2
    return 1
  else
    ln -s "${target}" "${link}"
  fi
}

for modules in "${closure}"/node_modules/.bun/browserslist@*/node_modules; do
  ensure_cli_link "${modules}" update-browserslist-db
done
for modules in "${closure}"/node_modules/.bun/update-browserslist-db@*/node_modules; do
  ensure_cli_link "${modules}" browserslist
done
