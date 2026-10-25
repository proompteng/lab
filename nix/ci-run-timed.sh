#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 3 ]]; then
  echo "Usage: ci-run-timed <phase> <log-file> <command> [<arg> ...]" >&2
  exit 2
fi

phase="$1"
log_file="$2"
shift 2

mkdir -p "$(dirname "${log_file}")"
timings_file="${NIX_OCI_TIMINGS_FILE:-${NIX_OCI_LOG_DIR:-$(dirname "${log_file}")}/timings.tsv}"

start_epoch="$(date +%s)"
set +e
"$@" 2>&1 | tee "${log_file}"
status="${PIPESTATUS[0]}"
set -e
end_epoch="$(date +%s)"
duration="$((end_epoch - start_epoch))"

printf '%s\t%s\t%s\t%s\n' "${phase}" "${status}" "${duration}" "${log_file}" >> "${timings_file}"

if [[ "${status}" -ne 0 ]]; then
  echo "Command failed in phase ${phase} after ${duration}s with status ${status}." >&2
  exit "${status}"
fi

echo "Completed phase ${phase} in ${duration}s."
