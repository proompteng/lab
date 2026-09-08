#!/usr/bin/env bash
set -euo pipefail

readonly CODEX_VERSION='0.149.0'
readonly CODEX_AMD64_SHA512='b995da37d24fc6ed3f8e39eaa8979377891160f9e35592b732256775f1b59878446a80ca2fb49c5877cfaaf0043a3c2c48312641294c7d4926bd8a7f08772263'
readonly CODEX_ARM64_SHA512='7c05cfa6f2286fed7544d6494bd095553b0a6fe5781f0df0a0614f8f8d83edf536c01254288da37c07387cb24db6ba7045e70b796eb4d66b6430739221b5aeb8'
readonly CODEX_REGISTRY='https://registry.npmjs.org'

codex_platform=''
codex_sha512=''
codex_target=''
temporary_directory=''

cleanup() {
  if [[ -n "$temporary_directory" && -d "$temporary_directory" ]]; then
    rm -rf -- "$temporary_directory"
  fi
}

fail() {
  printf 'bootstrap-codex: %s\n' "$*" >&2
  exit 1
}

select_platform() {
  case "$(uname -m)" in
    x86_64)
      codex_platform='linux-x64'
      codex_sha512="$CODEX_AMD64_SHA512"
      codex_target='x86_64-unknown-linux-musl'
      ;;
    aarch64 | arm64)
      codex_platform='linux-arm64'
      codex_sha512="$CODEX_ARM64_SHA512"
      codex_target='aarch64-unknown-linux-musl'
      ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

validate_manifest() {
  select_platform
  [[ "$CODEX_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid Codex version'
  [[ "$codex_sha512" =~ ^[0-9a-f]{128}$ ]] || fail 'invalid Codex SHA-512 digest'
  [[ "$CODEX_REGISTRY" == 'https://registry.npmjs.org' ]] || fail 'unexpected Codex registry'
}

install_codex() {
  validate_manifest
  [[ -n "${HOME:-}" && "$HOME" == /* ]] || fail 'HOME must be an absolute path'

  umask 077
  local codex_root="$HOME/.tengri/codex"
  local install_name="${CODEX_VERSION}-${codex_platform}-${codex_sha512:0:16}"
  local install_root="$codex_root/$install_name"
  local native_binary="$install_root/package/vendor/$codex_target/bin/codex"
  local marker="$install_root/.tengri-codex-manifest"
  local expected_marker="version=${CODEX_VERSION} platform=${codex_platform} sha512=${codex_sha512}"
  local binary_link="$HOME/.local/bin/codex"

  mkdir -p "$codex_root" "$HOME/.local/bin"
  chmod 0700 "$HOME/.tengri" "$codex_root" "$HOME/.local" "$HOME/.local/bin"

  if [[ -d "$install_root" ]]; then
    [[ -x "$native_binary" ]] || fail "existing Codex install is incomplete: $install_root"
    [[ -f "$marker" ]] || fail "existing Codex install has no manifest: $install_root"
    [[ "$(<"$marker")" == "$expected_marker" ]] || fail "existing Codex install has an invalid manifest: $install_root"
  else
    temporary_directory="$(mktemp -d "$codex_root/.install.XXXXXX")"
    trap cleanup EXIT HUP INT TERM

    local archive="$temporary_directory/codex.tgz"
    local extracted="$temporary_directory/extracted"
    local archive_url="$CODEX_REGISTRY/@openai/codex/-/codex-${CODEX_VERSION}-${codex_platform}.tgz"
    mkdir -p "$extracted"

    curl \
      --proto '=https' \
      --tlsv1.2 \
      --fail \
      --location \
      --silent \
      --show-error \
      --retry 5 \
      --retry-all-errors \
      --connect-timeout 15 \
      --max-time 600 \
      --output "$archive" \
      "$archive_url"
    printf '%s  %s\n' "$codex_sha512" "$archive" | sha512sum --check --status -
    tar --extract --gzip --file "$archive" --directory "$extracted" --no-same-owner --no-same-permissions

    local extracted_binary="$extracted/package/vendor/$codex_target/bin/codex"
    [[ -x "$extracted_binary" ]] || fail 'verified Codex package does not contain the native binary'
    printf '%s\n' "$expected_marker" > "$extracted/.tengri-codex-manifest"
    mv "$extracted" "$install_root"

    rm -rf -- "$temporary_directory"
    temporary_directory=''
    trap - EXIT HUP INT TERM
  fi

  local temporary_link="$HOME/.local/bin/.codex-link.$$"
  rm -f -- "$temporary_link"
  ln -s "$native_binary" "$temporary_link"
  mv -Tf "$temporary_link" "$binary_link"
}

case "${1:-}" in
  --validate-manifest)
    validate_manifest
    exit 0
    ;;
  --install-only)
    install_codex
    exit 0
    ;;
  --)
    shift
    (( $# > 0 )) || fail 'missing Nanoagent command'
    install_codex
    exec "$@"
    ;;
  *)
    fail 'expected --validate-manifest, --install-only, or -- COMMAND'
    ;;
esac
