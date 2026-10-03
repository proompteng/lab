#!/usr/bin/env bash
set -euo pipefail
member=crates/metadata-server/src/raft/server/member.rs
network=crates/metadata-server/src/raft/network
cat /proof/election-connection-manager.rs >> "$network/connection_manager.rs"
cat /proof/election-networking.rs >> "$network/networking.rs"
cat /proof/metadata-election-connect.rs >> "$member"

tests=(
  cold_pre_vote_reaches_transport_without_new_campaign
  cold_vote_reaches_transport_after_hard_state_persistence
)
run_proof() {
  cargo test --locked -p restate-metadata-server \
    "raft::server::member::cold_election_connection_proof::$1" -- --exact --nocapture --test-threads=1
}

patch --batch --fuzz=0 --reverse -p1 < /tmp/metadata-election-connect.patch
: > /proof/election-baseline.log
for name in "${tests[@]}"; do
  log="/proof/election-baseline-$name.log"
  if run_proof "$name" > "$log" 2>&1; then
    cat "$log"
    echo "Regression unexpectedly passed without the cold-election fix: $name" >&2
    exit 1
  fi
  tee -a /proof/election-baseline.log < "$log"
  grep -q '^running 1 test$' "$log"
  grep -q 'COLD_PEER_BRANCH_CONFIRMED:' "$log"
  grep -q 'COLD_PEER_CAMPAIGN_DROPPED:' "$log"
done

patch --batch --fuzz=0 -p1 < /tmp/metadata-election-connect.patch
cat /proof/metadata-election-connect-safety.rs >> "$member"
: > /proof/election-patched.log
for name in "${tests[@]}"; do
  log="/proof/election-patched-$name.log"
  run_proof "$name" 2>&1 | tee "$log" | tee -a /proof/election-patched.log
  grep -q 'test result: ok. 1 passed;' "$log"
done
# The process-global RocksDB manager is intentionally isolated for each test, as upstream does.
for name in \
  same_term_pre_campaign_replaces_all_old_requests \
  successful_new_campaign_also_discards_old_pending_requests \
  stale_role_term_and_membership_are_discarded \
  removed_voters_cannot_send_or_receive_deferred_requests \
  expiry_is_bounded_and_failed_peer_does_not_block_healthy_peer \
  full_and_closed_channels_are_not_requeued \
  ordinary_messages_are_not_queued_and_ready_only_send_never_connects \
  address_changes_discard_deferred_request \
  cold_snapshot_keeps_existing_failure_reporting; do
  log="/proof/election-patched-$name.log"
  cargo test --locked -p restate-metadata-server \
    "raft::server::member::cold_election_safety_proof::$name" -- --exact --nocapture --test-threads=1 \
    2>&1 | tee "$log" | tee -a /proof/election-patched.log
  grep -q 'test result: ok. 1 passed;' "$log"
done
