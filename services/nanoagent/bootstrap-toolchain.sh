#!/usr/bin/env bash
set -euo pipefail

readonly NODE_VERSION='24.11.1'
readonly BUN_VERSION='1.4.0'
readonly TOOLCHAIN_BUNDLE='/usr/share/nanoagent/node-bun.tar.gz'

platform=''
temporary_directory=''

cleanup() {
  if [[ -n "$temporary_directory" && -d "$temporary_directory" ]]; then
    rm -rf -- "$temporary_directory"
  fi
}

fail() {
  printf 'bootstrap-toolchain: %s\n' "$*" >&2
  exit 1
}

select_platform() {
  case "$(uname -m)" in
    x86_64) platform='linux-x64' ;;
    aarch64 | arm64) platform='linux-arm64' ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

validate_manifest() {
  select_platform
  [[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid Node version'
  [[ "$BUN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid Bun version'
  [[ -r "$TOOLCHAIN_BUNDLE" ]] || fail "toolchain bundle is unavailable: $TOOLCHAIN_BUNDLE"
}

validate_install() {
  local install_root="$1"
  local expected_marker="$2"
  local marker="$install_root/.tengri-toolchain-manifest"

  [[ -x "$install_root/node/bin/node" ]] || fail "Node install is incomplete: $install_root"
  [[ -x "$install_root/node/lib/node_modules/npm/bin/npm-cli.js" ]] || fail "npm install is incomplete: $install_root"
  [[ -x "$install_root/node/lib/node_modules/npm/bin/npx-cli.js" ]] || fail "npx install is incomplete: $install_root"
  [[ -x "$install_root/bun/bin/bun" ]] || fail "Bun install is incomplete: $install_root"
  [[ -f "$marker" ]] || fail "toolchain install has no manifest: $install_root"
  [[ "$(<"$marker")" == "$expected_marker" ]] || fail "toolchain install has an invalid manifest: $install_root"
  [[ "$("$install_root/node/bin/node" --version)" == "v$NODE_VERSION" ]] || fail 'Node version mismatch'
  [[ "$("$install_root/bun/bin/bun" --version)" == "$BUN_VERSION" ]] || fail 'Bun version mismatch'
}

link_binary() {
  local source="$1"
  local destination="$2"
  local temporary_link="${destination}.tmp.$$"

  rm -f -- "$temporary_link"
  ln -s "$source" "$temporary_link"
  mv -Tf "$temporary_link" "$destination"
}

install_toolchain() {
  validate_manifest
  [[ -n "${HOME:-}" && "$HOME" == /* ]] || fail 'HOME must be an absolute path'

  umask 077
  local toolchain_root="$HOME/.tengri/toolchains"
  local install_name="node-${NODE_VERSION}-bun-${BUN_VERSION}-${platform}"
  local install_root="$toolchain_root/$install_name"
  local expected_marker="node=${NODE_VERSION} bun=${BUN_VERSION} platform=${platform}"

  mkdir -p "$toolchain_root" "$HOME/.local/bin"
  chmod 0700 "$HOME/.tengri" "$toolchain_root" "$HOME/.local" "$HOME/.local/bin"

  if [[ -d "$install_root" ]]; then
    validate_install "$install_root" "$expected_marker"
  else
    temporary_directory="$(mktemp -d "$toolchain_root/.install.XXXXXX")"
    trap cleanup EXIT HUP INT TERM
    tar \
      --extract \
      --gzip \
      --file "$TOOLCHAIN_BUNDLE" \
      --directory "$temporary_directory" \
      --no-same-owner \
      --no-same-permissions
    printf '%s\n' "$expected_marker" > "$temporary_directory/.tengri-toolchain-manifest"
    validate_install "$temporary_directory" "$expected_marker"
    mv "$temporary_directory" "$install_root"
    temporary_directory=''
    trap - EXIT HUP INT TERM
  fi

  link_binary "$install_root/node/bin/node" "$HOME/.local/bin/node"
  link_binary "$install_root/node/lib/node_modules/npm/bin/npm-cli.js" "$HOME/.local/bin/npm"
  link_binary "$install_root/node/lib/node_modules/npm/bin/npx-cli.js" "$HOME/.local/bin/npx"
  link_binary "$install_root/bun/bin/bun" "$HOME/.local/bin/bun"
  link_binary "$install_root/bun/bin/bun" "$HOME/.local/bin/bunx"
}

case "${1:-}" in
  --validate-manifest)
    validate_manifest
    exit 0
    ;;
  --install-only)
    install_toolchain
    exit 0
    ;;
  --)
    shift
    (( $# > 0 )) || fail 'missing Nanoagent command'
    install_toolchain
    exec "$@"
    ;;
  *)
    fail 'expected --validate-manifest, --install-only, or -- COMMAND'
    ;;
esac
