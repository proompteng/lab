# Mimir on shared Kafka

Mimir 3.2.1 uses `kafka-kafka-bootstrap.kafka.svc.cluster.local:9093` and the dedicated
`observability.mimir.ingest.v1` topic in namespace `kafka`. Port 9093 is the existing internal listener also used by
Tempo. Port 9092 requires SCRAM. This migration does not change listener authentication or Kafka permissions.

The Kafka application owns the topic: three partitions, replication factor three, minimum ISR two, 24-hour
retention, and a 16,000,000-byte maximum message. Mimir owns no Kafka broker and cannot auto-create its topic.
Increase topic partitions before increasing the three ingester replicas. Ingester IDs map to partition IDs.

Metric history remains in the existing `mimir-blocks` bucket and ingester PVCs. Alertmanager and ruler storage are
unchanged. The retired broker PVC and older snapshot/restore PVC are retained data, with no running consumer.

## Hard cutover order

This procedure requires an explicitly authorized maintenance operation. Render the proposed manifests, validate
all Mimir roles with the exact 3.2.1 binary, and clear PR CI/review before pausing ingestion. Capture application
revisions, Pod and PVC identities, topic offsets, native Mimir metrics, and current/historical query results.

1. Temporarily annotate only the `observability` Application with `argocd.argoproj.io/skip-reconcile=true`, verify
   there is no active sync, then merge the reviewed configuration. Keep the Kafka application reconciling normally.
2. Wait for the shared `KafkaTopic` to be Ready. Confirm all three partitions have three in-sync replicas, the
   intended retention/message limits, and no existing consumer offsets for Mimir's three ingester IDs.
3. Scale the Mimir distributor and ruler Deployments to zero. Both can produce records. Wait for all their old
   Pods to terminate normally; collectors receive retryable write failures and buffer during this interval.
4. Compare the old topic's final end offsets with each ingester's last consumed offset. Mimir records the last
   consumed record itself, so it must equal Kafka's end offset minus one. Check every nonempty partition and abort
   retirement if any has no consuming owner or remains behind. Confirm offsets stop advancing after writers exit.
5. Call each ingester's `POST /ingester/flush?wait=true`. HTTP success alone does not establish successful shipping:
   also inspect flush/ship logs and failure counters, and confirm no unshipped head remains. Preserve all TSDB PVCs.
6. Scale the ingester StatefulSet to zero and wait for every old ingester Pod to terminate before resuming Argo.
   Remove the Application's skip-reconcile annotation. Argo applies the shared Kafka configuration, starts the
   configured replicas, and prunes the bundled Kafka StatefulSet and Services after the sync health gates pass.
7. Confirm every running Mimir component uses the shared address/topic. Check ingester startup logs show the new
   topic's start offset, then advancing consumed offsets. Verify fresh remote writes become queryable, historical
   queries still return their baseline data, collector buffers recover, and Kafka produce failures do not increase
   during the observation window. Confirm all partitions retain three in-sync replicas and no bundled broker Pod,
   StatefulSet, Service, restore Job, or restore ConfigMap remains.

The Application pause is temporary operational state, not a second desired configuration. If drain/flush checks
fail before step 6, restore the original replica counts while resolving that failure and keep reconciliation paused:
main already contains the shared Kafka configuration. Do not delete the broker or its data before draining succeeds.
Remove the pause when completing the cutover. After switching to shared Kafka, repair forward on that cluster.
Restarting the retired cluster would split the metric stream and is not a supported recovery path.

## Offsets and data preservation

In Mimir 3.2.1, `consumer_group_offset_commit_file_enforced` defaults to false and is explicitly false here.
The reader uses the destination Kafka consumer group's offset for this topic. When no such offset exists it starts
at the beginning of the partition. Consequently, the old `/data/tsdb/kafka-offset.json` cannot skip records in the
new topic. Keep `consume_from_position_at_startup` at its default `last-offset`; forcing `start` permanently would
replay the retained topic on every restart. Do not copy old broker consumer offsets into the shared cluster.

No mirroring, dual write, or fallback Kafka backend is configured. Retained volumes are for data recovery only.
Do not delete ingester PVCs, TSDB/WAL directories, or the Mimir S3 buckets during this operation.

## Evidence sources

- [Mimir Kafka backend configuration](https://grafana.com/docs/mimir/latest/configure/configure-kafka-backend/)
- [Mimir flush API and its verification limit](https://grafana.com/docs/mimir/latest/references/http-api/#flush-blocks)
- [Exact 3.2.1 Kafka offset configuration](https://github.com/grafana/mimir/blob/mimir-3.2.1/pkg/storage/ingest/config.go)
- [Exact 3.2.1 reader startup behavior](https://github.com/grafana/mimir/blob/mimir-3.2.1/pkg/storage/ingest/reader.go)
