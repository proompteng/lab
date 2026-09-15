#!/usr/bin/env bash

set -Eeuo pipefail

OMNI_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
NUC_SSH_TARGET=${NUC_SSH_TARGET:-kalmyk@nuc.ide-newton.ts.net}
NUC_OMNI_DIR=${NUC_OMNI_DIR:-/home/kalmyk/omni}

command -v rsync >/dev/null 2>&1 || {
  printf 'error: rsync is required\n' >&2
  exit 1
}

rsync --archive --checksum --compress \
  --exclude '.env' \
  --exclude 'backups/' \
  --exclude 'state/' \
  "${OMNI_DIR}/" "${NUC_SSH_TARGET}:${NUC_OMNI_DIR}/"

printf 'synced tracked Omni configuration to %s:%s without touching remote secrets\n' "${NUC_SSH_TARGET}" "${NUC_OMNI_DIR}"
