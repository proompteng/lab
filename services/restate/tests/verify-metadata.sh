#!/usr/bin/env bash
set -euo pipefail
test_name=metadata_sync_keeps_timers_and_network_responsive
run_regression() {
  rm -f /proof/armed /proof/injected
  LD_PRELOAD=/proof/slow-fsync.so cargo test --locked -p restate-metadata-server \
    "$test_name" -- --ignored --nocapture --test-threads=1
}
patch --batch --fuzz=0 --reverse -p1 < /tmp/metadata-background.patch
if run_regression 2>&1 | tee /proof/baseline.log; then
  echo 'Regression unexpectedly passed without the metadata fix' >&2
  exit 1
fi
if ! grep -q 'ASYNC_WORKER_BLOCKED:' /proof/baseline.log; then
  tail -100 /proof/baseline.log
  echo 'Baseline failed before reproducing the async-worker stall' >&2
  exit 1
fi
patch --batch --fuzz=0 -p1 < /tmp/metadata-background.patch
run_regression 2>&1 | tee /proof/patched.log
# Upstream's RocksDbManager is process-global and shuts down after each test (nextest isolates tests too).
for name in append_entries apply_snapshot initial_values overwrite_entries trim; do
  cargo test --locked -p restate-metadata-server "raft::storage::rocksdb::tests::$name" -- --exact --test-threads=1
done
