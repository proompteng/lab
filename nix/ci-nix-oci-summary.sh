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

sum_timed_seconds() {
  if [[ ! -f "${timings_file}" ]]; then
    echo 0
    return
  fi
  awk -F $'\t' '{total += $3} END {print total + 0}' "${timings_file}"
}

count_timed_phases() {
  if [[ ! -f "${timings_file}" ]]; then
    echo 0
    return
  fi
  awk 'NF > 0 {count += 1} END {print count + 0}' "${timings_file}"
}

count_image_cache_status() {
  local expected_status="$1"
  local count file
  count=0
  if ! compgen -G "${log_dir}/image-cache-push-status-*.txt" >/dev/null; then
    echo 0
    return
  fi
  for file in "${log_dir}"/image-cache-push-status-*.txt; do
    if grep -q -E "^${expected_status}[[:space:]]" "${file}"; then
      count=$((count + 1))
    fi
  done
  echo "${count}"
}

count_image_cache_status_rows() {
  local expected_status="$1"
  if ! compgen -G "${log_dir}/image-cache-push-status-*.txt" >/dev/null; then
    echo 0
    return
  fi
  awk -F $'\t' -v expected="${expected_status}" '$1 == expected {count += 1} END {print count + 0}' \
    "${log_dir}"/image-cache-push-status-*.txt
}

sum_image_cache_skipped_bytes() {
  if ! compgen -G "${log_dir}/image-cache-push-status-*.txt" >/dev/null; then
    echo 0
    return
  fi
  awk -F $'\t' '$1 == "skipped-size" {total += $2} END {print total + 0}' \
    "${log_dir}"/image-cache-push-status-*.txt
}

count_existing_image_archives() {
  local image_tar archive_count
  archive_count=0
  if ! compgen -G "${log_dir}/*.log" >/dev/null; then
    echo 0
    return
  fi
  while IFS= read -r image_tar; do
    if [[ -f "${image_tar}" ]]; then
      archive_count=$((archive_count + 1))
    fi
  done < <(grep -h -Eo 'at /nix/store/[^.[:space:]]+.*\.(tar|tar\.gz|tgz)\.' "${log_dir}"/*.log 2>/dev/null | sed -E 's/^at //; s/\.$//')
  echo "${archive_count}"
}

sum_existing_image_archive_bytes() {
  local image_tar archive_bytes
  archive_bytes=0
  if ! compgen -G "${log_dir}/*.log" >/dev/null; then
    echo 0
    return
  fi
  while IFS= read -r image_tar; do
    if [[ -f "${image_tar}" ]]; then
      archive_bytes=$((archive_bytes + $(wc -c < "${image_tar}")))
    fi
  done < <(grep -h -Eo 'at /nix/store/[^.[:space:]]+.*\.(tar|tar\.gz|tgz)\.' "${log_dir}"/*.log 2>/dev/null | sed -E 's/^at //; s/\.$//')
  echo "${archive_bytes}"
}

attic_substitutions="$(count_matches "copying path .*from 'http://attic\\.attic\\.svc\\.cluster\\.local/lab'")"
nixos_substitutions="$(count_matches "copying path .*from 'https://cache\\.nixos\\.org'")"
local_builds="$(count_matches "building '/nix/store/.*\\.drv'")"
planned_build_blocks="$(count_matches 'this derivation will be built:|these [0-9]+ derivations will be built:')"
timed_phases="$(count_timed_phases)"
timed_seconds="$(sum_timed_seconds)"
cache_substitutions=$((attic_substitutions + nixos_substitutions))
image_archives="$(count_existing_image_archives)"
image_archive_bytes="$(sum_existing_image_archive_bytes)"
image_cache_warm_successes="$(count_image_cache_status succeeded)"
image_cache_warm_failures="$(count_image_cache_status failed)"
image_cache_warm_skipped_size="$(count_image_cache_status_rows skipped-size)"
image_cache_warm_skipped_bytes="$(sum_image_cache_skipped_bytes)"

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
  echo "## Nix OCI Performance Contract"
  echo
  echo "| Metric | Value |"
  echo "| --- | ---: |"
  echo "| Timed phases | ${timed_phases} |"
  echo "| Total timed seconds | ${timed_seconds} |"
  echo "| Cache substitutions | ${cache_substitutions} |"
  echo "| Existing image archives | ${image_archives} |"
  echo "| Existing image archive bytes | ${image_archive_bytes} |"
  echo "| Image archive Attic warm successes | ${image_cache_warm_successes} |"
  echo "| Image archive Attic warm failures | ${image_cache_warm_failures} |"
  echo "| Image archive Attic warm size skips | ${image_cache_warm_skipped_size} |"
  echo "| Image archive Attic warm skipped bytes | ${image_cache_warm_skipped_bytes} |"
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
