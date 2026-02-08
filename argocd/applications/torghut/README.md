# Torghut

This directory contains the Argo CD application resources for the torghut namespace.

## Technical Analysis (TA) Replay from Scratch

Use this flow when you need a clean recompute of TA outputs.

This procedure is **destructive** (deletes Kafka topics and Flink state). Treat it as emergency-only and require explicit
human approval before running in production.

0) Pause trading first (recommended).
- Set `TRADING_ENABLED=false` in `argocd/applications/torghut/knative-service.yaml` and Argo sync.

1) Suspend the job.
```
kubectl -n torghut patch flinkdeployment torghut-ta --type=merge -p '{"spec":{"job":{"state":"suspended"}}}'
```

2) Drop and recreate output topics.

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

3) Remove checkpoint and savepoint state.

Precheck: identify a MinIO pod that has `mc` configured (this often varies by cluster).
```
kubectl -n minio get pods
```

```
kubectl -n minio exec <minio-pod> -- mc rm -r --force \
  local/flink-checkpoints/torghut/technical-analysis/checkpoints

kubectl -n minio exec <minio-pod> -- mc rm -r --force \
  local/flink-checkpoints/torghut/technical-analysis/savepoints
```

4) Set a fresh consumer group and replay from the beginning.
```
# argocd/applications/torghut/ta/configmap.yaml
TA_GROUP_ID: "torghut-ta-<date>"
TA_AUTO_OFFSET_RESET: "earliest"
```
Apply via GitOps (preferred) or emergency-only direct apply. Then restart:
```
kubectl -n torghut patch flinkdeployment torghut-ta --type=merge -p '{"spec":{"restartNonce":<bump>}}'
```

5) Resume the job (if still suspended).
```
kubectl -n torghut patch flinkdeployment torghut-ta --type=merge -p '{"spec":{"job":{"state":"running"}}}'
```

### Notes
- Micro-bars are built from `torghut.trades.v1`; if trades are empty, output will be empty.
- `torghut.bars.1m.v1` is only used to feed signal computation.
- Checkpoints completing do not imply any output was emitted.
