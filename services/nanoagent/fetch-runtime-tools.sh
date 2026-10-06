#!/usr/bin/env bash
set -euo pipefail

# Image/test creation only. Boot helpers consume the same pinned packages locally.
output="${1:?usage: fetch-runtime-tools.sh <seed-directory> [codex|code-server|spire-agent ...]}"
shift
if (( $# == 0 )); then set -- codex code-server spire-agent; fi
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
for tool in "$@"; do
  case "$tool" in codex|code-server|spire-agent) ;; *) exit 2 ;; esac
  helper="$script_dir/bootstrap-$tool.sh"
  [[ -f "$helper" ]] || helper="/usr/local/bin/bootstrap-$tool"
  manifest="$(bash "$helper" --archive-manifest)"
  mapfile -t fields <<< "$manifest"
  [[ "${#fields[@]}" == 5 && "${fields[0]}" != */* && "${fields[3]}" == https://* ]]
  archive="$output/${fields[0]}"
  case "${fields[1]}" in
    sha256) [[ "${fields[2]}" =~ ^[a-f0-9]{64}$ ]]; verifier=sha256sum ;;
    sha512) [[ "${fields[2]}" =~ ^[a-f0-9]{128}$ ]]; verifier=sha512sum ;;
    *) exit 2 ;;
  esac
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    --retry 3 --retry-all-errors --connect-timeout 15 --max-time 600 \
    --output "$work/original.tgz" "${fields[3]}"
  printf '%s  %s\n' "${fields[2]}" "$work/original.tgz" | "$verifier" --check --status -
  mkdir "$work/payload"
  members=()
  [[ "${fields[4]}" == . ]] || members+=("${fields[4]}")
  tar --extract --gzip --file "$work/original.tgz" --directory "$work/payload" \
    --no-same-owner --no-same-permissions "${members[@]}"
  # Preserve complete Codex/code-server packages; SPIRE's guest needs only the agent.
  XZ_OPT='-T2 -9' tar --create --xz --file "$archive" --directory "$work/payload" .
  (cd "$output" && sha256sum "${fields[0]}" > "${fields[0]}.sha256")
  stat --printf='%n_bytes=%s\n' "$archive"
  rm -rf -- "$work/payload" "$work/original.tgz"
done
