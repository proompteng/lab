#!/usr/bin/env bash
set -euo pipefail
fixture_runtime="${1:?Pass an isolated runtime directory}"
mkdir -p "$fixture_runtime"
fixture_archive="$fixture_runtime/keycloak-26.8.2.tar.gz"
if [[ ! -f "$fixture_archive" ]]; then
  curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 \
    https://repo.maven.apache.org/maven2/org/keycloak/keycloak-quarkus-dist/26.8.2/keycloak-quarkus-dist-26.8.2.tar.gz \
    --output "$fixture_archive"
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
