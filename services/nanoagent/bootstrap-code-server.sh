#!/usr/bin/env bash
set -euo pipefail

readonly CODE_SERVER_VERSION='4.135.0'
code_platform=''
code_digest=''
code_temporary=''

fail() { printf 'bootstrap-code-server: %s\n' "$*" >&2; exit 1; }
cleanup() { if [[ -n "$code_temporary" ]]; then rm -rf -- "$code_temporary"; fi; }

select_platform() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) code_platform='linux-amd64'; code_digest='300ef4e37e469e6368a4673c6a623e1c9ba8a34f42b394fb49c431a8900bc7d1' ;;
    Linux-aarch64|Linux-arm64) code_platform='linux-arm64'; code_digest='fe6561798415e709109cb902dca2a57a687240af7d8220f6fa1d01cd2ae0541e' ;;
    Darwin-arm64) code_platform='macos-arm64'; code_digest='30e8c2fcf3cb7d125c06401ed7f24ff0609634b7ee01f259a52c7d462b90bd4e' ;;
    Darwin-x86_64) code_platform='macos-amd64'; code_digest='71738fb5bd886bca3d792d819bfdaa4698b27569d69c494c538a9ec1c0d6bb5b' ;;
    *) fail 'unsupported platform' ;;
  esac
}

install_code_server() {
  select_platform
  [[ -n "${HOME:-}" && "$HOME" == /* ]] || fail 'HOME must be an absolute path'
  umask 077
  local code_root="$HOME/.tengri/code-server"
  local install_name="code-server-${CODE_SERVER_VERSION}-${code_platform}"
  local install_root="$code_root/${install_name}-${code_digest:0:16}"
  local expected_marker="version=$CODE_SERVER_VERSION platform=$code_platform sha256=$code_digest"
  mkdir -p "$code_root" "$HOME/.local/bin"
  if [[ -d "$install_root" ]]; then
    [[ -x "$install_root/bin/code-server" && -f "$install_root/.tengri-manifest" ]] || fail 'existing installation is incomplete'
    [[ "$(<"$install_root/.tengri-manifest")" == "$expected_marker" ]] || fail 'existing installation has an invalid manifest'
  else
    code_temporary="$(mktemp -d "$code_root/.install.XXXXXX")"
    trap cleanup EXIT HUP INT TERM
    local archive="$code_temporary/code-server.tgz"
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      --retry 3 --retry-all-errors --connect-timeout 15 --max-time 180 \
      --output "$archive" \
      "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${install_name}.tar.gz"
    if command -v sha256sum >/dev/null 2>&1; then
      printf '%s  %s\n' "$code_digest" "$archive" | sha256sum --check --status -
    else
      printf '%s  %s\n' "$code_digest" "$archive" | shasum -a 256 --check --status -
    fi
    tar -xzf "$archive" -C "$code_temporary" --no-same-owner --no-same-permissions
    [[ -x "$code_temporary/$install_name/bin/code-server" ]] || fail 'verified archive is missing code-server'
    printf '%s\n' "$expected_marker" > "$code_temporary/$install_name/.tengri-manifest"
    mv "$code_temporary/$install_name" "$install_root"
    cleanup
    code_temporary=''
    trap - EXIT HUP INT TERM
  fi
  local temporary_link="$HOME/.local/bin/.code-server-link.$$"
  ln -s "$install_root/bin/code-server" "$temporary_link"
  mv -f "$temporary_link" "$HOME/.local/bin/code-server"
}

case "${1:-}" in
  --validate-manifest) select_platform ;;
  --install-only) install_code_server ;;
  *) fail 'expected --validate-manifest or --install-only' ;;
esac
