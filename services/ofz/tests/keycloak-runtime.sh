#!/usr/bin/env bash
set -euo pipefail
fixture_runtime="${1:?Pass an isolated runtime directory}"
mkdir -p "$fixture_runtime"
fixture_archive="$fixture_runtime/keycloak-26.7.4.tar.gz"
if [[ ! -f "$fixture_archive" ]]; then
  curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 \
    https://github.com/keycloak/keycloak/releases/download/26.7.4/keycloak-26.7.4.tar.gz \
    --output "$fixture_archive"
fi
python3 - "$fixture_archive" "$fixture_runtime" <<'PY'
import hashlib
import pathlib
import sys
import tarfile
archive,root=map(pathlib.Path,sys.argv[1:])
if hashlib.sha256(archive.read_bytes()).hexdigest()!="04823c336b797a7e18889a44262a7a64e6bf624cbbcc518c85e2622176ff2eee":
    raise RuntimeError("Official Keycloak 26.7.4 digest mismatch")
with tarfile.open(archive) as source:
    source.extractall(root,filter="data")
PY
printf '%s\n' "$fixture_runtime/keycloak-26.7.4/bin/kc.sh"
