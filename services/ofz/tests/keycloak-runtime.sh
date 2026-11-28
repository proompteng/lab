#!/usr/bin/env bash
set -euo pipefail
fixture_runtime="${1:?Pass an isolated runtime directory}"
mkdir -p "$fixture_runtime"
fixture_archive="$fixture_runtime/keycloak-26.8.2.tar.gz"
if [[ ! -f "$fixture_archive" ]]; then
  downloaded=false
  for url in \
    "https://github.com/keycloak/keycloak/releases/download/26.8.2/keycloak-26.8.2.tar.gz" \
    "https://repo.maven.apache.org/maven2/org/keycloak/keycloak-quarkus-dist/26.8.2/keycloak-quarkus-dist-26.8.2.tar.gz"; do
    rm -f "${fixture_archive}.tmp"
    if curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 \
      --retry 5 --retry-all-errors --retry-delay 5 --connect-timeout 20 --max-time 180 \
      "$url" \
      --output "${fixture_archive}.tmp"; then
      mv -f "${fixture_archive}.tmp" "$fixture_archive"
      downloaded=true
      break
    fi
  done
  if [[ "$downloaded" != true ]]; then
    echo "Failed to download official Keycloak 26.8.2 archive from GitHub Releases and Maven Central" >&2
    exit 1
  fi
fi
python3 - "$fixture_archive" "$fixture_runtime" <<'PY'
import hashlib
import pathlib
import sys
import tarfile
archive,root=map(pathlib.Path,sys.argv[1:])
if hashlib.sha256(archive.read_bytes()).hexdigest()!="dd124787283918bc597628887168333465ee2a811a389e0003569e52be7e487f":
    raise RuntimeError("Official Keycloak 26.8.2 digest mismatch")
with tarfile.open(archive) as source:
    source.extractall(root,filter="data")
PY
printf '%s\n' "$fixture_runtime/keycloak-26.8.2/bin/kc.sh"
