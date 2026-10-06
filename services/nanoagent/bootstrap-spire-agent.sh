#!/usr/bin/env bash
set -euo pipefail

readonly SPIRE_VERSION='1.15.3'
readonly TOOL_SEED_ROOT="${NANOAGENT_TOOL_SEED_ROOT:-/usr/share/nanoagent}"
spire_platform=''
spire_digest=''
spire_temporary=''

fail() { printf 'bootstrap-spire-agent: %s\n' "$*" >&2; exit 1; }
cleanup() { if [[ -n "$spire_temporary" ]]; then rm -rf -- "$spire_temporary"; fi; }

select_platform() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) spire_platform='amd64'; spire_digest='ca1a4d1155317bdd2afc7f36663828a10410c7c840e54725b90b4064b0a301c7' ;;
    Linux-aarch64|Linux-arm64) spire_platform='arm64'; spire_digest='a9982b3ca7de489def22265fd4586d8e13091ecb6fddf6adcea9291313b18886' ;;
    *) fail 'unsupported platform' ;;
  esac
}

install_agent() {
  select_platform
  [[ -n "${HOME:-}" && "$HOME" == /* ]] || fail 'HOME must be an absolute path'
  umask 077
  local spire_root="$HOME/.tengri/spire-agent"
  local spire_install="$spire_root/${SPIRE_VERSION}-${spire_platform}-${spire_digest:0:16}"
  local spire_marker="version=$SPIRE_VERSION platform=$spire_platform sha256=$spire_digest"
  mkdir -p "$spire_root" "$HOME/.local/bin"
  if [[ -d "$spire_install" ]]; then
    [[ -x "$spire_install/spire-agent" && -f "$spire_install/.tengri-manifest" ]] || fail 'existing installation is incomplete'
    [[ "$(<"$spire_install/.tengri-manifest")" == "$spire_marker" ]] || fail 'existing installation has an invalid manifest'
  else
    spire_temporary="$(mktemp -d "$spire_root/.install.XXXXXX")"
    trap cleanup EXIT HUP INT TERM
    local spire_archive="$TOOL_SEED_ROOT/spire-${SPIRE_VERSION}-linux-${spire_platform}.tar.xz"
    [[ -r "$spire_archive" ]] || fail "image package is missing: $spire_archive"
    (cd "$TOOL_SEED_ROOT" && sha256sum --check --status "${spire_archive##*/}.sha256")
    mkdir "$spire_temporary/install"
    tar -xJf "$spire_archive" -C "$spire_temporary" --no-same-owner --no-same-permissions
    local spire_binary="$spire_temporary/spire-${SPIRE_VERSION}/bin/spire-agent"
    [[ -x "$spire_binary" ]] || fail 'verified archive is missing spire-agent'
    mv "$spire_binary" "$spire_temporary/install/spire-agent"
    printf '%s\n' "$spire_marker" > "$spire_temporary/install/.tengri-manifest"
    mv "$spire_temporary/install" "$spire_install"
    cleanup
    spire_temporary=''
    trap - EXIT HUP INT TERM
  fi
  local spire_link="$HOME/.local/bin/.spire-agent-link.$$"
  ln -s "$spire_install/spire-agent" "$spire_link"
  mv -f "$spire_link" "$HOME/.local/bin/spire-agent"
}

case "${1:-}" in
  --archive-manifest)
    select_platform
    printf '%s\n' "spire-${SPIRE_VERSION}-linux-${spire_platform}.tar.xz" sha256 "$spire_digest" \
      "https://github.com/spiffe/spire/releases/download/v${SPIRE_VERSION}/spire-${SPIRE_VERSION}-linux-${spire_platform}-musl.tar.gz" \
      "spire-${SPIRE_VERSION}/bin/spire-agent"
    ;;
  --validate-manifest) select_platform ;;
  --install-only) install_agent ;;
  *) fail 'expected --validate-manifest or --install-only' ;;
esac
