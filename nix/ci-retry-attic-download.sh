#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Usage: ci-retry-attic-download <command> [<arg> ...]" >&2
  exit 2
fi

attempt_dir="$(mktemp -d)"
trap 'rm -rf "${attempt_dir}"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

retryable_attic_download() {
  # Nix 2.28 cannot resume a partially consumed NAR without HTTP byte ranges,
  # which Attic does not provide. Only this transport failure permits a retry
  # that can rebuild from the same derivation if substitution fails again.
  # Any other terminal error on the first attempt keeps the original failure.
  LC_ALL=C awk \
    -v partial="^[[:space:]]*error: unable to download 'http://attic[.]attic[.]svc[.]cluster[.]local/lab/nar/[0-9a-z]{32}[.]nar': HTTP error 200 [(]curl error: Transferred a partial file[)][[:space:]]*$" \
    -v substitutes="^[[:space:]]*error: some substitutes for the outputs of derivation '/nix/store/[^']+[.]drv' failed [(]usually happens due to networking issues[)]; try '--fallback' to build derivation from source[[:space:]]*$" \
    -v dependencies="^[[:space:]]*error: [0-9]+ dependencies of derivation '/nix/store/[^']+[.]drv' failed to build[[:space:]]*$" \
    '
      {
        gsub(/\033\[[0-9;]*[mK]/, "")
        if ($0 ~ /^[[:space:]]*error:/) {
          if ($0 ~ partial) found_partial = 1
          else if ($0 !~ substitutes && $0 !~ dependencies) found_other = 1
        }
      }
      END { exit !(found_partial && !found_other) }
    ' "$1"
}

retry_flags=()
for attempt in 1 2; do
  attempt_log="${attempt_dir}/${attempt}.log"
  set +e
  "$@" "${retry_flags[@]}" 2>&1 | tee "${attempt_log}"
  statuses=("${PIPESTATUS[@]}")
  set -e
  if [[ "${statuses[1]}" -ne 0 ]]; then exit "${statuses[1]}"; fi
  status="${statuses[0]}"
  if [[ "${status}" -eq 0 ]]; then exit 0; fi
  if [[ "${attempt}" -eq 2 || "${status}" -ne 1 ]] || ! retryable_attic_download "${attempt_log}"; then
    exit "${status}"
  fi
  # Native fallback covers all substitutions in this retry, retaining Nix's
  # content and signature checks; the enclosing timeout owns both attempts.
  retry_flags=(--fallback)
  echo "Attic interrupted a NAR stream; retrying the same build once with source fallback in 5s within the existing deadline." >&2
  sleep 5
done
