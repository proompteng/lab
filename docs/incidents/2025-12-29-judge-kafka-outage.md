# Incident Report: Kafka broker storage fault blocked Codex judge pipeline

- **Date**: 29 Dec 2025
- **Detected by**: Missing Codex judge runs for new workflow completions; Kafka topic empty
- **Reported by**: gregkonush
- **Services Affected**: Kafka (kafka namespace), Longhorn (storage), Argo Events (eventbus), Jangar codex-judge
- **Severity**: High - automated judge pipeline halted and no new runs were created

## Impact Summary

- Kafka broker `kafka-pool-a-2` entered `CrashLoopBackOff` due to an I/O error reading `meta.properties` on its data volume.
- The Longhorn PVC `data-kafka-pool-a-2` was detached and faulted, preventing the broker from starting.
- Argo workflow completion events were not reaching the EventBus/Kafka topic, so Jangar did not create new `codex_judge.runs` records.
- Codex judge runs for recent issues (e.g., 2148/2152) were missing, blocking end-to-end automation.
- After recovery, workflow completion events flowed through EventBus and Kafka, Jangar persisted runs, and the judge produced evaluations.

## Timeline (UTC)

| Time | Event |
|------|-------|
| 2025-12-29 ~00:10 | Investigation begins: Kafka topic `argo.workflows.completions` shows 0 messages; Jangar DB has no new runs. |
| 2025-12-29 ~00:15 | Kafka broker `kafka-pool-a-2` found in `CrashLoopBackOff` with I/O error reading `/var/lib/kafka/data/kafka-log2/meta.properties`; Longhorn volume `data-kafka-pool-a-2` faulted/detached. |
| 2025-12-29 ~00:20 | Longhorn replica salvage initiated; volume reattached and broker rescheduled. |
| 2025-12-29 ~00:38 | Argo Events EventSource/Sensor synced to remove workflow status filters and add log trigger for visibility. |
| 2025-12-29 00:43:43 | EventSource publishes workflow completion; Sensor produces Kafka message; EventBus stream `default` increments to 1. |
| 2025-12-29 00:43:43 | Jangar inserts `codex_judge.runs` for issue 2166 (status `judging`). |
| 2025-12-29 00:50:20 | Judge evaluation completes; run status `completed`, evaluation `decision=pass`. |

## Root Cause

- **Primary**: Kafka broker storage failure. Longhorn reported the PVC backing `kafka-pool-a-2` as detached/faulted, and Kafka crashed with an I/O error reading `meta.properties`. This degraded Kafka availability and blocked completion events from being processed.

## Contributing Factors

- **EventSource filters**: The Argo Events EventSource for workflow completions used status filters that did not match the actual update payload, preventing events from reaching the EventBus even after Kafka recovered.
- **Lack of visibility**: No log trigger existed on the Sensor to confirm events were firing, which slowed diagnosis.

## Remediation Actions

1. **Recovered Kafka broker storage**
   - Salvaged the Longhorn replica for `data-kafka-pool-a-2`, cleared failed state, and reattached the volume.
   - Confirmed `kafka-pool-a-2` restarted and the Kafka CR reported Ready.

2. **Unblocked workflow completion events**
   - Removed EventSource status filters that were dropping completion updates.
   - Added a Sensor log trigger to confirm event delivery and Kafka publish success.
   - Synced Argo CD application `froussard` to apply changes.

3. **Validated end-to-end pipeline**
   - Verified EventBus stream `default` received completion events.
   - Verified Kafka topic `argo.workflows.completions` contained the workflow completion message.
   - Verified Jangar persisted the run and evaluation in Postgres.

## Manual Interventions (Commands)

### Longhorn replica salvage (Kafka PVC)

```bash
# Trigger salvage and clear failed state on the replica
kubectl -n longhorn-system patch replica pvc-40d29f68-1901-457b-8313-1ca1310861c6-r-fcd0a5d2 \
  -p '{"spec":{"salvageRequested":true,"desireState":"running","failedAt":"","lastFailedAt":""}}'
```

### Kafka verification (no secrets in command)

```bash
# Consume one message from workflow completion topic (credentials provided via secret)
kubectl -n kafka exec kafka-pool-a-0 -- bash -lc '
cat > /tmp/client.properties <<KAFKA_CFG
security.protocol=SASL_PLAINTEXT
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required \
  username="<from-secret>" password="<from-secret>";
KAFKA_CFG
bin/kafka-console-consumer.sh --bootstrap-server kafka-kafka-bootstrap.kafka:9092 \
  --topic argo.workflows.completions --from-beginning --max-messages 1 \
  --timeout-ms 5000 --consumer.config /tmp/client.properties
'
```

### EventBus stream verification

```bash
kubectl -n argo-workflows exec eventbus-default-js-0 -c metrics -- sh -c \
  'wget -qO- "http://localhost:8222/jsz?streams=1"' | \
  jq -r '.account_details[0].stream_detail[] | .name + " messages=" + (.state.messages|tostring)'
```

### Jangar Postgres run/evaluation verification

```bash
# Query run + evaluation for issue 2166
kubectl cnpg psql jangar-db -n jangar -- -d jangar -c \
  "select issue_number, status, updated_at from codex_judge.runs where issue_number=2166;"
```

## What Went Well

- Longhorn replica salvage restored the Kafka broker without data loss.
- Adding the Sensor log trigger immediately confirmed event delivery and Kafka publish success.
- The end-to-end flow was validated with a real workflow completion and persisted judge evaluation.

## What Went Poorly

- Kafka broker failure was not detected early enough for this pipeline; we found it only after the judge stalled.
- EventSource filters silently dropped events, masking the primary failure and extending downtime.
- Lack of visibility in the Sensor made it harder to confirm whether events were published or consumed.

## Follow-up Actions

1. Add monitoring/alerts on EventBus stream message inactivity for workflow completions.
2. Add a health check for Kafka consumer lag or empty topic when workflows complete.
3. Add validation tests for EventSource filters against real workflow payloads.
4. Document the recovery steps in the Kafka runbook (reference: `docs/runbooks/kafka-broker-storage-recovery.md`).
