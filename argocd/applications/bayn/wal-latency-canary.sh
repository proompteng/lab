#!/usr/bin/env bash
set -euo pipefail

[[ $# == 3 ]]
canary_data_root=$1
canary_wal_root=$2
canary_work_root=$3
for canary_path in "$canary_data_root" "$canary_wal_root" "$canary_work_root"; do
  [[ $canary_path == /* && $canary_path == *bayn-wal-canary* && $canary_path != *\'* ]]
  mkdir -p "$canary_path"
done
[[ $canary_data_root != "$canary_wal_root" ]]
canary_active_data=
canary_writer_pid=
canary_stop_file=
canary_work=

cleanup() {
  local canary_exit=$?
  trap - EXIT
  if [[ -n $canary_stop_file ]]; then touch "$canary_stop_file"; fi
  if [[ -n $canary_writer_pid ]]; then
    wait "$canary_writer_pid" || canary_exit=1
  fi
  if [[ -n $canary_active_data ]]; then
    pg_ctl -D "$canary_active_data" -m fast -w -t 30 stop || canary_exit=1
  fi
  if [[ $canary_exit != 0 && -n $canary_work ]]; then
    for canary_log in "$canary_work"/{initdb,postgres,warmup,pgbench}.log; do
      if [[ -f $canary_log ]]; then
        printf 'BAYN_WAL_CANARY_FAILURE_LOG file=%s exitCode=%s\n' "$canary_log" "$canary_exit"
        cat "$canary_log"
      fi
    done
  fi
  exit "$canary_exit"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cat >"$canary_work_root/append.sql" <<'SQL'
BEGIN;
INSERT INTO receipts (payload)
SELECT string_agg(md5(random()::text), '') FROM generate_series(1, 32);
COMMIT;
SQL

canary_phase=0
for canary_layout in shared separate separate shared; do
  canary_phase=$((canary_phase + 1))
  canary_name="$canary_layout-$canary_phase"
  canary_data="$canary_data_root/$canary_name"
  canary_wal="$canary_wal_root/$canary_name"
  canary_work="$canary_work_root/$canary_name"
  [[ ! -e $canary_data && ! -e $canary_wal && ! -e $canary_work ]]
  mkdir -p "$canary_work/socket"
  canary_init=(initdb -D "$canary_data" --username=canary --auth-local=trust --auth-host=reject --data-checksums)
  if [[ $canary_layout == separate ]]; then canary_init+=(--waldir="$canary_wal"); fi
  "${canary_init[@]}" >"$canary_work/initdb.log"
  canary_active_data=$canary_data
  pg_ctl -D "$canary_data" -l "$canary_work/postgres.log" -w -t 60 \
    -o "-c listen_addresses='' -c unix_socket_directories='$canary_work/socket' -c fsync=on -c full_page_writes=on -c synchronous_commit=on -c wal_sync_method=fdatasync -c track_io_timing=on -c track_wal_io_timing=on" start
  canary_connection=(-h "$canary_work/socket" -p 5432 -U canary -d postgres)
  psql "${canary_connection[@]}" -X -v ON_ERROR_STOP=1 -c \
    'CREATE TABLE receipts (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payload text NOT NULL);'
  psql "${canary_connection[@]}" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT json_build_object('event','bayn.wal-canary.settings','phase',$canary_phase,'layout','$canary_layout','version',current_setting('server_version'),'fsync',current_setting('fsync'),'fullPageWrites',current_setting('full_page_writes'),'synchronousCommit',current_setting('synchronous_commit'),'walSyncMethod',current_setting('wal_sync_method'),'systemIdentifier',(pg_control_system()).system_identifier,'capacityQualified',false);"
  printf 'BAYN_WAL_CANARY_PATH phase=%s layout=%s wal=%s\n' "$canary_phase" "$canary_layout" "$(readlink -f "$canary_data/pg_wal")"
  df -P "$canary_data" "$canary_data/pg_wal"
  pgbench "${canary_connection[@]}" -n -c 1 -j 1 -M prepared --max-tries=1 \
    -f "$canary_work_root/append.sql" -T 5 >"$canary_work/warmup.log"
  canary_stop_file="$canary_work/writer.stop"
  (
    while [[ ! -e $canary_stop_file ]]; do
      timeout 50 dd if=/dev/urandom of="$canary_data_root/$canary_name.data-writer" \
        bs=128K count=1 oflag=append conv=notrunc,fdatasync status=none
      sleep 0.1
    done
  ) &
  canary_writer_pid=$!
  canary_started=$(date -u +%Y-%m-%dT%H:%M:%S.%6NZ)
  printf 'BAYN_WAL_CANARY_START phase=%s layout=%s at=%s\n' "$canary_phase" "$canary_layout" "$canary_started"
  canary_benchmark_exit=0
  pgbench "${canary_connection[@]}" -n -c 1 -j 1 -M prepared --max-tries=1 \
    -f "$canary_work_root/append.sql" -T 20 --log --log-prefix="$canary_work/transactions" \
    >"$canary_work/pgbench.log" || canary_benchmark_exit=$?
  canary_ended=$(date -u +%Y-%m-%dT%H:%M:%S.%6NZ)
  touch "$canary_stop_file"
  canary_writer_exit=0
  wait "$canary_writer_pid" || canary_writer_exit=$?
  canary_writer_pid=
  canary_stop_file=
  cat "$canary_work/pgbench.log"
  canary_raw_logs=("$canary_work"/transactions.*)
  printf 'BAYN_WAL_CANARY_RAW_BEGIN phase=%s layout=%s exitCode=%s\n' "$canary_phase" "$canary_layout" "$canary_benchmark_exit"
  if [[ -f ${canary_raw_logs[0]} ]]; then cat "${canary_raw_logs[@]}"; fi
  printf 'BAYN_WAL_CANARY_RAW_END phase=%s layout=%s\n' "$canary_phase" "$canary_layout"
  printf '{"event":"bayn.wal-canary.execution","phase":%s,"layout":"%s","benchmarkExitCode":%s,"writerExitCode":%s}\n' \
    "$canary_phase" "$canary_layout" "$canary_benchmark_exit" "$canary_writer_exit"
  if [[ $canary_benchmark_exit != 0 ]]; then exit "$canary_benchmark_exit"; fi
  if [[ $canary_writer_exit != 0 ]]; then exit "$canary_writer_exit"; fi
  canary_count=$(awk '/^number of transactions actually processed:/ {print $NF}' "$canary_work/pgbench.log")
  [[ $canary_count =~ ^[1-9][0-9]*$ ]]
  awk '{if ($3 !~ /^[0-9]+$/ || $3 <= 0) exit 1; print $3}' "${canary_raw_logs[@]}" \
    | sort -n >"$canary_work/latencies-us.txt"
  awk -v phase="$canary_phase" -v layout="$canary_layout" -v expected="$canary_count" \
    -v started="$canary_started" -v ended="$canary_ended" '
    {latency[NR]=$1; if ($1 > 1000000) slow++}
    END {
      if (NR != expected || NR == 0) exit 1;
      p50=int((NR*50+99)/100); p95=int((NR*95+99)/100); p99=int((NR*99+99)/100);
      printf "{\"event\":\"bayn.wal-canary.phase\",\"phase\":%d,\"layout\":\"%s\",\"startedAt\":\"%s\",\"completedAt\":\"%s\",\"samples\":%d,\"p50Ms\":%.3f,\"p95Ms\":%.3f,\"p99Ms\":%.3f,\"maxMs\":%.3f,\"overOneSecond\":%d,\"capacityQualified\":false}\n", phase,layout,started,ended,NR,latency[p50]/1000,latency[p95]/1000,latency[p99]/1000,latency[NR]/1000,slow;
    }' "$canary_work/latencies-us.txt"
  psql "${canary_connection[@]}" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT json_build_object('event','bayn.wal-canary.io','phase',$canary_phase,'layout','$canary_layout','walIo',(SELECT json_agg(to_jsonb(i)) FROM pg_stat_io i WHERE object='wal' AND coalesce(fsyncs,0)>0));"
  pg_ctl -D "$canary_data" -m fast -w -t 30 stop
  canary_active_data=
done
printf '{"event":"bayn.wal-canary.complete","phases":4,"productionLayoutChanged":false,"capacityQualified":false}\n'
