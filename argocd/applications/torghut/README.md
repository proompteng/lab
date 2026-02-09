# Torghut

This directory contains the Argo CD application resources for the `torghut` namespace.

## TA replay workflow (canonical)

This is the single, canonical TA replay/backfill workflow that oncall should follow (and that an AgentRun can later
automate via PR + Argo sync). Other docs should link here instead of duplicating steps.

### Scope / target resources (as deployed)
- Kubernetes namespace: `torghut`
- Flink TA job: `FlinkDeployment/torghut-ta` (`argocd/applications/torghut/ta/flinkdeployment.yaml`)
- TA config: `ConfigMap/torghut-ta-config` (`argocd/applications/torghut/ta/configmap.yaml`)
- Trading service: Knative `Service/torghut` (`argocd/applications/torghut/knative-service.yaml`)
- Kafka namespace/tools: `kafka` (Strimzi); bootstrap `kafka-kafka-bootstrap.kafka:9092`
- MinIO namespace/tools: `minio` (for Flink checkpoint/savepoint storage)

Kafka topics (v1):
- Inputs: `torghut.trades.v1`, `torghut.quotes.v1`, `torghut.bars.1m.v1`
- Outputs (derived): `torghut.ta.bars.1s.v1`, `torghut.ta.signals.v1`

### Replay window constraints (what can be replayed)
Replay is constrained by **both** Kafka retention (inputs) and ClickHouse TTL (outputs):
- **Kafka retention (inputs) is the hard limit:** if events aged out of Kafka, TA cannot replay them. v1 expected
  retention is **7–30 days** for ingest topics; confirm actual broker settings before assuming older data exists.
  See `docs/torghut/design-system/v1/component-kafka-topics-and-retention.md`.
- **ClickHouse TTL (outputs) limits how long replayed results persist:**
  - `ta_microbars`: TTL 30 days
  - `ta_signals`: TTL 14 days

If you replay data older than the ClickHouse TTL, it may be deleted during merges shortly after replay (see
`docs/torghut/design-system/v1/component-clickhouse-capacity-ttl-and-disk-guardrails.md`).

### Safety gates (read first)
- **Trading safety:** if there is any uncertainty about signal correctness (stale/corrupt/partial), pause trading first
  and keep it paused until verification passes:
  - set `TRADING_ENABLED=false` in `argocd/applications/torghut/knative-service.yaml`
  - keep `TRADING_LIVE_ENABLED=false` (safety backstop)
- **Unique consumer group required (hard requirement):** every replay/backfill must use a **new** `TA_GROUP_ID`
  (consumer-group isolation). Never reuse an old replay group id.
- **GitOps-first:** prefer changing manifests under `argocd/applications/torghut/**` and syncing via Argo CD.
  Emergency-only `kubectl patch` is allowed, but reconcile back to GitOps immediately after.
- **Not “one button destructive”:** default to Mode 1 (non-destructive). Mode 2 is explicitly destructive and requires an
  additional confirmation step + a recorded ticket/incident reference.

### Inputs to capture (for rollback)
- `PREV_TA_GROUP_ID` (current steady-state group id from `argocd/applications/torghut/ta/configmap.yaml`)
- `REPLAY_ID` (unique id used in group id + any backups), example: `2026-02-09T0315Z-INC1234`
- Current TA job state: `running` vs `suspended`

### Mode 1 (recommended): Non-destructive replay/backfill (consumer-group isolation)
Goal: recompute TA outputs from retained Kafka inputs without deleting topics or Flink state.

1) Pause trading (recommended; required if signal correctness is uncertain)
   - `argocd/applications/torghut/knative-service.yaml`: set `TRADING_ENABLED=false`, then Argo sync.
2) Suspend TA to stop writes while you switch group id
   - GitOps-first: set `spec.job.state: suspended` in `argocd/applications/torghut/ta/flinkdeployment.yaml`, then Argo sync.
   - Emergency-only:
     ```
     kubectl -n torghut patch flinkdeployment torghut-ta --type=merge -p '{"spec":{"job":{"state":"suspended"}}}'
     ```
3) Set a **fresh** replay consumer group + replay policy
   - Edit `argocd/applications/torghut/ta/configmap.yaml`:
     - `TA_GROUP_ID: "torghut-ta-replay-<REPLAY_ID>"`
     - `TA_AUTO_OFFSET_RESET: "earliest"`
4) Restart and resume TA (required to pick up ConfigMap env changes)
   - GitOps-first:
     - bump `spec.restartNonce` in `argocd/applications/torghut/ta/flinkdeployment.yaml`
     - set `spec.job.state: running`
     - Argo sync
   - Emergency-only restart nonce bump:
     ```
     kubectl -n torghut patch flinkdeployment torghut-ta --type=merge -p '{"spec":{"restartNonce":<bump>}}'
     ```
5) Verify replay progress and correctness (keep trading paused until green)
   - FlinkDeployment health:
     - `kubectl -n torghut get flinkdeployment torghut-ta`
   - ClickHouse freshness (examples):
     - `SELECT max(event_ts) FROM torghut.ta_signals WHERE symbol='NVDA';`
     - `SELECT max(event_ts) FROM torghut.ta_microbars WHERE symbol='NVDA';`
   - Expected behavior: lag will be high initially and should trend down toward real-time.

Notes:
- This mode may temporarily increase ClickHouse write volume and disk usage (replay inserts). Tables are designed for
  at-least-once and dedup via `ReplacingMergeTree`, but merges are not instantaneous.
- If you need a truly clean window (no duplicates / no stale partitions), treat that as a **separate explicitly
  destructive action** and follow `docs/torghut/design-system/v1/operations-ta-replay-and-recovery.md` plus ClickHouse
  change control.

### Mode 2 (emergency only): Destructive “replay from scratch”
This mode deletes derived Kafka topics and Flink checkpoint/savepoint state. Only use when Mode 1 is insufficient (for
example, corrupted checkpoint directory or irrecoverable derived-topic issues).

Before starting, get explicit human confirmation that the following are acceptable:
- Deleting/recreating **derived** topics: `torghut.ta.bars.1s.v1`, `torghut.ta.signals.v1`
- Deleting Flink checkpoint/savepoint directories under `s3a://flink-checkpoints/torghut/technical-analysis/...`

0) Pause trading (required)
- Set `TRADING_ENABLED=false` in `argocd/applications/torghut/knative-service.yaml` and Argo sync.

1) Suspend the job (same as Mode 1)

2) Back up Flink state directories (so rollback is possible)
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

3) Drop and recreate derived output topics (Kafka namespace `kafka`)
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

4) Remove checkpoint/savepoint state directories (destructive; after backup only)
```
kubectl -n minio exec <minio-pod> -- mc rm -r --force \
  local/flink-checkpoints/torghut/technical-analysis/checkpoints

kubectl -n minio exec <minio-pod> -- mc rm -r --force \
  local/flink-checkpoints/torghut/technical-analysis/savepoints
```

5) Set a fresh replay consumer group and replay from the beginning (same requirement as Mode 1)
```
# argocd/applications/torghut/ta/configmap.yaml
TA_GROUP_ID: "torghut-ta-replay-<REPLAY_ID>"
TA_AUTO_OFFSET_RESET: "earliest"
```
Apply via GitOps (preferred), then restart via `spec.restartNonce` bump and set `spec.job.state: running`.

6) Verify replay progress and correctness (keep trading paused until green)
- FlinkDeployment health:
  - `kubectl -n torghut get flinkdeployment torghut-ta`
- ClickHouse freshness:
  - `SELECT max(event_ts) FROM torghut.ta_signals WHERE symbol='NVDA';`

### Rollback / recovery if replay fails
1) Stop the job:
   - Set `spec.job.state: suspended` (GitOps-first) or patch the FlinkDeployment.
2) Restore steady-state config:
   - Revert `TA_GROUP_ID` to `PREV_TA_GROUP_ID` in `argocd/applications/torghut/ta/configmap.yaml`.
   - Bump `spec.restartNonce` in `argocd/applications/torghut/ta/flinkdeployment.yaml` to force restart.
   - Set `spec.job.state: running` and Argo sync.
3) If you used Mode 2 (deleted state), restore MinIO state from your backup prefix, then restart:
   - Copy `backup/<replay-id>/checkpoints` back to `.../checkpoints`
   - Copy `backup/<replay-id>/savepoints` back to `.../savepoints`
4) Verify with the checks above before unpausing trading.

If you performed destructive actions (topic deletion or ClickHouse deletion), rollback may require re-running the replay
or restoring from backups (see `docs/torghut/design-system/v1/disaster-recovery-and-backups.md`).
