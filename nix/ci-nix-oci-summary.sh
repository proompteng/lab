#!/usr/bin/env bash
set -euo pipefail

log_dir="${NIX_OCI_LOG_DIR:-}"
if [[ -z "${log_dir}" || ! -d "${log_dir}" ]]; then
  echo "No Nix OCI log directory found; skipping summary."
  exit 0
fi

summary_file="${GITHUB_STEP_SUMMARY:-}"
timings_file="${NIX_OCI_TIMINGS_FILE:-${log_dir}/timings.tsv}"

count_matches() {
  local pattern="$1"
  local counts
  if ! compgen -G "${log_dir}/*.log" >/dev/null; then
    echo 0
    return
  fi
  counts="$(grep -h -E -c "${pattern}" "${log_dir}"/*.log 2>/dev/null || true)"
  if [[ -z "${counts}" ]]; then
    echo 0
    return
  fi
  awk '{total += $1} END {print total + 0}' <<< "${counts}"
}

attic_substitutions="$(count_matches "copying path .*from 'http://attic\\.attic\\.svc\\.cluster\\.local/lab'")"
nixos_substitutions="$(count_matches "copying path .*from 'https://cache\\.nixos\\.org'")"
local_builds="$(count_matches "building '/nix/store/.*\\.drv'")"
planned_build_blocks="$(count_matches 'this derivation will be built:|these [0-9]+ derivations will be built:')"

{
  echo "## Nix OCI Cache Summary"
  echo
  echo "| Metric | Count |"
  echo "| --- | ---: |"
  echo "| Attic substitutions | ${attic_substitutions} |"
  echo "| cache.nixos.org substitutions | ${nixos_substitutions} |"
  echo "| Local derivation builds | ${local_builds} |"
  echo "| Planned local build blocks | ${planned_build_blocks} |"
  echo

  if [[ -f "${timings_file}" ]]; then
    echo "| Phase | Status | Seconds |"
    echo "| --- | ---: | ---: |"
    while IFS=$'\t' read -r phase status duration _log_file; do
      [[ -n "${phase}" ]] || continue
      echo "| ${phase} | ${status} | ${duration} |"
    done < "${timings_file}"
    echo
  fi
} | tee /tmp/nix-oci-cache-summary.md

if [[ -n "${summary_file}" ]]; then
  cat /tmp/nix-oci-cache-summary.md >> "${summary_file}"
fi
