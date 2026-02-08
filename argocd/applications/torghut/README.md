# Torghut

This directory contains the Argo CD application resources for the torghut namespace.

## TA replay workflow (canonical)

This section is the single, canonical “TA replay workflow” that oncall should follow (and that an AgentRun can later
automate via PR + Argo sync). Other docs should link here instead of duplicating steps.

### Scope and safety gates (read first)
- **Trading safety:** If this is a live environment (not paper), pause trading first and keep it paused until verification
  passes. This is not optional for destructive replays.
- **Unique consumer group required:** Every replay/backfill must use a **new** `TA_GROUP_ID` (consumer-group isolation).
  Never reuse an old replay group id.
- **GitOps-first:** Prefer changing manifests under `argocd/applications/torghut/**` and syncing via Argo CD.
  Emergency-only `kubectl patch` is allowed, but reconcile back to GitOps immediately after.
- **Not “one button destructive”:** The default workflow is non-destructive; destructive steps are explicitly marked and
  require additional confirmation.

### Inputs (concrete resource names)
- Namespace: `torghut`
- FlinkDeployment: `torghut-ta` (`argocd/applications/torghut/ta/flinkdeployment.yaml`)
- TA ConfigMap: `torghut-ta-config` (`argocd/applications/torghut/ta/configmap.yaml`)
- Ingest topics (inputs, retention-bounded):
  - Trades: `torghut.trades.v1` (`TA_TRADES_TOPIC`)
  - Quotes: `torghut.quotes.v1` (`TA_QUOTES_TOPIC`)
  - Bars 1m: `torghut.bars.1m.v1` (`TA_BARS1M_TOPIC`)
- Derived topics (outputs, safe to delete/recreate if needed):
  - Microbars: `torghut.ta.bars.1s.v1` (`TA_MICROBARS_TOPIC`)
  - Signals: `torghut.ta.signals.v1` (`TA_SIGNALS_TOPIC`)
- Checkpoints/savepoints: MinIO/S3 at `s3a://flink-checkpoints/torghut/technical-analysis/...` (see `state.*.dir` in
  `argocd/applications/torghut/ta/flinkdeployment.yaml`; creds via `Secret/observability-minio-creds`)
- ClickHouse: `svc/torghut-clickhouse:8123` (auth via `Secret/torghut-clickhouse-auth`)

### Replay window constraints (what can be replayed)
Replays are constrained by **Kafka ingest retention** and by **ClickHouse TTL**:
- **Kafka retention (hard limit):** You can only replay data that is still present in ingest topics. Expected ingest
  retention is ~7–30 days (see `docs/torghut/design-system/v1/component-kafka-topics-and-retention.md`).
- **ClickHouse TTL (storage limit):** Even if you replay older data, ClickHouse may delete it during merges if it exceeds
  TTL. As documented in the design system:
  - `torghut.ta_signals` TTL is 14 days
  - `torghut.ta_microbars` TTL is 30 days
  (see `docs/torghut/design-system/v1/component-clickhouse-capacity-ttl-and-disk-guardrails.md`)
- **Operational expectation:** If data is older than Kafka retention, TA replay/backfill is **not possible** with this
  pipeline; use an external historical source and a dedicated backfill path instead.

### Mode 1 (recommended): Non-destructive replay/backfill (consumer-group isolation)
This mode does **not** delete Kafka topics or Flink checkpoint directories. It is the safest default and is
automation-friendly.

0) Pause trading (required for live; recommended always).
- Set `TRADING_ENABLED=false` in `argocd/applications/torghut/knative-service.yaml` and Argo sync.

1) Record the current steady-state values (needed for rollback).
- From `argocd/applications/torghut/ta/configmap.yaml`, record:
  - `TA_GROUP_ID` (call this `PREV_TA_GROUP_ID`)
  - `TA_AUTO_OFFSET_RESET`
- From `argocd/applications/torghut/ta/flinkdeployment.yaml`, record:
  - `spec.job.state`
  - `spec.restartNonce` (if present)

2) Suspend the job (GitOps-first; emergency patch shown for reference).
- GitOps-first: set `spec.job.state: suspended` in `argocd/applications/torghut/ta/flinkdeployment.yaml` and Argo sync.
- Emergency-only:
  ```
  kubectl -n torghut patch flinkdeployment torghut-ta --type=merge -p '{"spec":{"job":{"state":"suspended"}}}'
  ```

3) Choose a unique replay consumer group id and set it.
- Required format guidance (example): `torghut-ta-replay-20260208T235900Z-INC1234`
- Update:
  ```
  # argocd/applications/torghut/ta/configmap.yaml
  TA_GROUP_ID: "torghut-ta-replay-<UTC-timestamp>-<ticket>"
  TA_AUTO_OFFSET_RESET: "earliest"
  ```
  **Important:** Do not switch back to `PREV_TA_GROUP_ID` after a successful replay; that can cause reprocessing from the
  old offsets. Treat the replay group as the new steady-state group id.

4) (Optional, destructive to ClickHouse) Clear the target replay window to avoid duplicates.
- Default is **non-destructive**: rely on ClickHouse dedup/replacing behavior.
- If you need a clean recompute for a specific time window, delete the affected ClickHouse partitions/parts first using
  an approved operational access path. Coordinate carefully; do not paste secrets into commands/tickets.

5) Restart and resume the job.
- GitOps-first: bump `spec.restartNonce` in `argocd/applications/torghut/ta/flinkdeployment.yaml` and set
  `spec.job.state: running`, then Argo sync.
- Emergency-only restart nonce bump:
  ```
  kubectl -n torghut patch flinkdeployment torghut-ta --type=merge -p '{"spec":{"restartNonce":<bump>}}'
  ```

6) Verify replay progress and correctness (keep trading paused until green).
- FlinkDeployment health:
  - `kubectl -n torghut get flinkdeployment torghut-ta`
- ClickHouse freshness:
  - `SELECT max(event_ts) FROM torghut.ta_signals WHERE symbol='NVDA';`
- Expected behavior: lag will be high initially and should trend down toward real-time.

### Mode 2 (emergency only): Destructive “replay from scratch”
This mode deletes derived Kafka topics and Flink checkpoint/savepoint state. Only use when Mode 1 is insufficient (for
example, corrupted state directory or irrecoverable output topic issues).

Before starting, get explicit human confirmation that the following are acceptable:
- Deleting/recreating **derived** topics: `torghut.ta.bars.1s.v1`, `torghut.ta.signals.v1`
- Deleting Flink checkpoint/savepoint directories under `s3a://flink-checkpoints/torghut/technical-analysis/...`

0) Pause trading (required).
- Set `TRADING_ENABLED=false` in `argocd/applications/torghut/knative-service.yaml` and Argo sync.

1) Suspend the job (same as Mode 1).

2) Back up Flink state directories (so rollback is possible).
Precheck: identify a MinIO pod (namespace `minio`) that has `mc` configured.
```
kubectl -n minio get pods
```

Backup (example; use a unique prefix per replay):
```
kubectl -n minio exec <minio-pod> -- mc cp -r \
  local/flink-checkpoints/torghut/technical-analysis/checkpoints \
  local/flink-checkpoints/torghut/technical-analysis/backup/<replay-id>/checkpoints

kubectl -n minio exec <minio-pod> -- mc cp -r \
  local/flink-checkpoints/torghut/technical-analysis/savepoints \
  local/flink-checkpoints/torghut/technical-analysis/backup/<replay-id>/savepoints
```

3) Drop and recreate derived output topics (Kafka namespace `kafka`).
Precheck: identify a Kafka pod that has `kafka-topics.sh` available.
```
kubectl -n kafka get pods
```

```
kubectl -n kafka exec <kafka-pod> -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server kafka-kafka-bootstrap.kafka:9092 \
  --delete --topic torghut.ta.bars.1s.v1

kubectl -n kafka exec <kafka-pod> -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server kafka-kafka-bootstrap.kafka:9092 \
  --delete --topic torghut.ta.signals.v1

kubectl -n kafka exec <kafka-pod> -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server kafka-kafka-bootstrap.kafka:9092 \
  --create --topic torghut.ta.bars.1s.v1 \
  --partitions 1 --replication-factor 3

kubectl -n kafka exec <kafka-pod> -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server kafka-kafka-bootstrap.kafka:9092 \
  --create --topic torghut.ta.signals.v1 \
  --partitions 1 --replication-factor 3
```

4) Remove checkpoint/savepoint state directories (destructive; after backup only).
```
kubectl -n minio exec <minio-pod> -- mc rm -r --force \
  local/flink-checkpoints/torghut/technical-analysis/checkpoints

kubectl -n minio exec <minio-pod> -- mc rm -r --force \
  local/flink-checkpoints/torghut/technical-analysis/savepoints
```

5) Set a fresh consumer group and replay from the beginning (same requirement as Mode 1).
```
# argocd/applications/torghut/ta/configmap.yaml
TA_GROUP_ID: "torghut-ta-replay-<UTC-timestamp>-<ticket>"
TA_AUTO_OFFSET_RESET: "earliest"
```
Apply via GitOps (preferred), then restart via `spec.restartNonce` bump and set `spec.job.state: running`.

### Rollback / recovery if replay fails
1) Stop the job:
   - Set `spec.job.state: suspended` (GitOps-first) or patch the FlinkDeployment.
2) Restore the previous steady-state config:
   - Revert `TA_GROUP_ID` to `PREV_TA_GROUP_ID` in `argocd/applications/torghut/ta/configmap.yaml` **only if** you also
     understand it will resume from the previous offsets.
3) If you used Mode 2 (deleted state), restore MinIO state from your backup prefix, then restart:
   - Copy `backup/<replay-id>/checkpoints` back to `.../checkpoints`
   - Copy `backup/<replay-id>/savepoints` back to `.../savepoints`
4) Argo sync and verify with the checks above before unpausing trading.
