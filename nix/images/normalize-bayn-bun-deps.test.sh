#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fixture="$(mktemp -d)"
trap 'rm -rf "${fixture}"' EXIT
browser='node_modules/.bun/browserslist@4.28.1+fixture/node_modules'
updater='node_modules/.bun/update-browserslist-db@1.2.3+fixture/node_modules'

make_fixture() {
  local root="$1"
  mkdir -p "${root}/${browser}/browserslist" "${root}/${updater}/update-browserslist-db"
  printf 'locked browserslist bytes\n' > "${root}/${browser}/browserslist/cli.js"
  printf 'locked updater bytes\n' > "${root}/${updater}/update-browserslist-db/cli.js"
  ln -s '../../update-browserslist-db@1.2.3+fixture/node_modules/update-browserslist-db' "${root}/${browser}/update-browserslist-db"
  ln -s '../../browserslist@4.28.1+fixture/node_modules/browserslist' "${root}/${updater}/browserslist"
}

for state in absent browser updater both; do
  root="${fixture}/${state}"
  make_fixture "${root}"
  mkdir -p "${root}/${browser}/.bin" "${root}/${updater}/.bin"
  if [[ "${state}" == browser || "${state}" == both ]]; then
    ln -s ../update-browserslist-db/cli.js "${root}/${browser}/.bin/update-browserslist-db"
  fi
  if [[ "${state}" == updater || "${state}" == both ]]; then
    ln -s ../browserslist/cli.js "${root}/${updater}/.bin/browserslist"
  fi
  bash "${script_dir}/normalize-bayn-bun-deps.sh" "${root}"
  bash "${script_dir}/normalize-bayn-bun-deps.sh" "${root}"
  test "$(readlink "${root}/${browser}/.bin/update-browserslist-db")" = ../update-browserslist-db/cli.js
  test "$(readlink "${root}/${updater}/.bin/browserslist")" = ../browserslist/cli.js
  test "$(cat "${root}/${browser}/browserslist/cli.js")" = 'locked browserslist bytes'
  test "$(cat "${root}/${updater}/update-browserslist-db/cli.js")" = 'locked updater bytes'
done
for state in browser updater both; do
  diff -r "${fixture}/absent" "${fixture}/${state}"
done

for state in wrong-link regular-file missing-target; do
  root="${fixture}/${state}"
  make_fixture "${root}"
  mkdir -p "${root}/${browser}/.bin"
  case "${state}" in
    wrong-link) ln -s ../unexpected/cli.js "${root}/${browser}/.bin/update-browserslist-db" ;;
    regular-file) printf 'unexpected executable\n' > "${root}/${browser}/.bin/update-browserslist-db" ;;
    missing-target) rm "${root}/${updater}/update-browserslist-db/cli.js" ;;
  esac
  if bash "${script_dir}/normalize-bayn-bun-deps.sh" "${root}" > "${fixture}/${state}.log" 2>&1; then
    printf 'Unexpected normalization success for %s\n' "${state}" >&2
    exit 1
  fi
done

mkdir -p "${fixture}/unrelated/node_modules/.bun"
bash "${script_dir}/normalize-bayn-bun-deps.sh" "${fixture}/unrelated"
printf 'Bayn dependency CLI normalization: four layouts converge; replay and invalid targets checked.\n'
