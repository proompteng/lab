#!/usr/bin/env bash
set -euo pipefail
root=$1
shard=$2
postgres=$3
query() { docker exec "$postgres" psql -X -v ON_ERROR_STOP=1 -U bayn -d bayn_test -Atc "$1"; }
query 'ALTER ROLE bayn SET jit TO off'
test "$(query 'SHOW jit')" = off
workers=()
case "$(bun --version)" in
  1.4.2) variant=base ;;
  1.4.3) variant=candidate; workers=(2) ;;
  *) exit 1 ;;
esac
results="$root/$variant"
mkdir -p "$results"
nproc | tee "$results/cores.txt"
cp ".ci-proof/bayn-pg-two-workers-$variant.ts" services/bayn/tools/test-postgres.ts
RESULTS="$results" BAYN_CI_POSTGRES_TIMINGS_PATH="$results/timings.json" /usr/bin/time -p -o "$results/time" \
  bun run --cwd services/bayn test:postgres "$shard/4" "${workers[@]}" > "$results/console.log" 2>&1 || {
    tail -80 "$results/console.log"
    exit 1
  }
cat "$results/time"
test -z "$(query "SELECT datname FROM pg_database WHERE datname LIKE 'bayn_%' AND datname <> 'bayn_test'")"
