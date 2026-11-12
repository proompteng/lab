#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" != 1 || ( "$1" != prepare && "$1" != qualify ) ]]; then
  echo 'Usage: ci-arc-native-qualification <prepare|qualify>' >&2
  exit 2
fi

mode="$1"
native_dir="${RUNNER_TEMP:?}/arc-native"
mkdir -p "$native_dir"
export NIX_OCI_LOG_DIR="$native_dir"
source_revision="$(git rev-parse HEAD)"
receipt="$native_dir/receipt.json"
iterations="$native_dir/iterations.jsonl"
out_link="$native_dir/result"
work_deadline="$(jq -er '.workDeadline | numbers' "$native_dir/budget.json")"
phase="$mode"
status=running
native_start=null
native_end=null
touch "$iterations"

write_receipt() {
  local exit_code="$1"
  jq --arg source "$source_revision" --arg status "$status" --arg phase "$phase" \
    --argjson exitCode "$exit_code" --argjson nativeStart "$native_start" --argjson nativeEnd "$native_end" \
    --argjson workDeadline "$work_deadline" \
    --slurpfile iterations "$iterations" \
    '. + {schemaVersion:"arc.native-image-qualification.v1",sourceRevision:$source,packageAttr:"bayn-image",
      status:$status,phase:$phase,exitCode:$exitCode,workDeadline:$workDeadline,
      nativeStart:$nativeStart,nativeEnd:$nativeEnd,iterations:$iterations}' \
    "${RUNNER_TEMP}/arc-ready.json" > "$receipt.tmp"
  mv "$receipt.tmp" "$receipt"
}

finish() {
  local exit_code="$?"
  if (( exit_code != 0 )); then status=failed; fi
  write_receipt "$exit_code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_phase() {
  phase="$1"
  local limit="$2"
  local remaining
  shift 2
  remaining=$((work_deadline - $(date +%s) - 30))
  if (( remaining <= 0 )); then
    echo 'Native work deadline exhausted; reserving time for failure artifacts.' | tee "$native_dir/$phase.log" >&2
    printf '%s\t124\t0\t%s\n' "$phase" "$native_dir/$phase.log" >> "$native_dir/timings.tsv"
    return 124
  fi
  if (( remaining < limit )); then limit="$remaining"; fi
  bash nix/ci-run-timed.sh "$phase" "$native_dir/$phase.log" timeout --kill-after=30s "${limit}s" "$@"
}

inspect_image() {
  local suffix="$1"
  local image_tar
  image_tar="$(readlink -f "$out_link")"
  test -f "$image_tar"
  run_phase "inspect-$suffix" 300 bash nix/oci-inspect-archive.sh "$image_tar"
  run_phase "verify-$suffix" 300 bash nix/verify-bayn-image-command.sh "$image_tar" trading
}

if [[ "$mode" == prepare ]]; then
  : > "$iterations"
  write_receipt 0
  # Nix 2.28 requires a valid output before --rebuild can check it. Realization,
  # dependency downloads and this first inspection are outside the measured load.
  run_phase realize 2700 nix build .#bayn-image --print-build-logs --out-link "$out_link"
  inspect_image seed
  status=prepared
  exit 0
fi

jq -e --arg source "$source_revision" \
  '.status == "prepared" and .sourceRevision == $source and .exitCode == 0' "$receipt" >/dev/null
phase=rendezvous
write_receipt 0
prefix="arc-native-ready-${RUN_ATTEMPT:?}-"
deadline=$((SECONDS + 10 * 60))
count=0
while (( SECONDS < deadline )); do
  if (( $(date +%s) + 30 >= work_deadline )); then
    echo 'Native work deadline exhausted during preparation rendezvous.' >&2
    exit 124
  fi
  count="$(timeout --kill-after=5s 30s gh api \
    "repos/${GH_REPO:?}/actions/runs/${RUN_ID:?}/artifacts?per_page=100" \
    --jq "[.artifacts[] | select(.expired == false and (.name | startswith(\"$prefix\")))] | length")"
  test "$count" = 10 && break
  sleep 15
done
test "$count" = 10 || { echo 'Ten native image outputs did not become prepared within ten minutes' >&2; exit 1; }

# Only the forced rebuild/inspection loop contributes to the native-work window.
# The aggregate gate still requires an observed thirty-minute intersection among
# all ten jobs; the extra five minutes here are only a rendezvous-skew allowance.
iteration=0
native_start="$(date +%s)"
native_end="$native_start"
while (( native_end - native_start < 35 * 60 )); do
  iteration=$((iteration + 1))
  if (( iteration == 1 )); then iteration_start="$native_start"; else iteration_start="$(date +%s)"; fi
  run_phase "rebuild-$iteration" 2700 nix build .#bayn-image --rebuild --print-build-logs --out-link "$out_link"
  inspect_image "$iteration"
  native_end="$(date +%s)"
  jq -n --argjson iteration "$iteration" --argjson start "$iteration_start" --argjson end "$native_end" \
    --slurpfile image "$native_dir/inspect-$iteration.log" \
    '{iteration:$iteration,start:$start,end:$end,rebuild:true,exitCode:0,image:$image[0]}' >> "$iterations"
  write_receipt 0
done
status=passed
