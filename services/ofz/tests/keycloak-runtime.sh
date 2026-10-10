#!/usr/bin/env bash
set -euo pipefail
fixture_runtime="${1:?Pass an isolated runtime directory}"
mkdir -p "$fixture_runtime"
fixture_archive="$fixture_runtime/keycloak-26.7.3.tar.gz"
if [[ ! -f "$fixture_archive" ]]; then
  curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 \
    https://github.com/keycloak/keycloak/releases/download/26.7.3/keycloak-26.7.3.tar.gz \
    --output "$fixture_archive"
fi
python3 - "$fixture_archive" "$fixture_runtime" <<'PY'
import hashlib
import pathlib
import sys
import tarfile
archive,root=map(pathlib.Path,sys.argv[1:])
if hashlib.sha256(archive.read_bytes()).hexdigest()!="77657f30b7e90d70f727712ce1c967f430fd6a5e9f458d32d8c6df0635345f47":
    raise RuntimeError("Official Keycloak 26.7.3 digest mismatch")
with tarfile.open(archive) as source:
    source.extractall(root,filter="data")
PY
printf '%s\n' "$fixture_runtime/keycloak-26.7.3/bin/kc.sh"
