#!/bin/sh
set -eu

run_diagnostic() {
  status=0
  node "$@" || status=$?
  if [ "$status" != 42 ]; then
    echo "Expected non-qualifying diagnostic exit 42, received $status" >&2
    if [ "$status" = 0 ]; then return 1; fi
    return "$status"
  fi
}

case "${BAYN_TEST_CAPTURE_ATTRIBUTION:-0}" in
  1)
    run_diagnostic "$@" full "$BAYN_TEST_CAPTURE_ATTRIBUTION_CORPUS_HASH" "$BAYN_TEST_CAPTURE_ATTRIBUTION_ANCHOR"
    run_diagnostic "$@" proof-light "$BAYN_TEST_CAPTURE_ATTRIBUTION_CORPUS_HASH" "$BAYN_TEST_CAPTURE_ATTRIBUTION_ANCHOR"
    ;;
  0)
    if [ "${BAYN_TEST_CAPTURE_CPU_PROFILE:-0}" != 1 ] && [ "${BAYN_TEST_CAPTURE_IO_DIAGNOSTICS:-0}" != 1 ]; then
      exec node "$@"
    fi
    run_diagnostic "$@"
    ;;
  *) echo 'Unknown capture attribution mode' >&2; exit 2 ;;
esac
printf '%s\n' '{"capacityResult":"NON_QUALIFYING_DIAGNOSTIC","capacityQualification":false}'
exit 42
