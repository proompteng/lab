# Mimir Kafka 4.3 upgrade

Mimir's bundled broker is separate from the main Strimzi cluster. Preserve its
cluster ID `5L6g3nShT-eMCtK--X86sw`, node ID 0, two topics, 150 partitions, and
the original `kafka-data-observability-mimir-kafka-0` PVC. Do not reformat logs
or advance metadata features before the upgraded broker passes acceptance.

## Preparation

Capture the live PVC UID, disk identity, topic IDs, partition leaders/ISR,
metadata high watermark, and every partition's end offset. Flush the running
broker's filesystem with `sync` after capturing that baseline. Commit the
versioned VolumeSnapshot and clone rehearsal through GitOps. This is an
online snapshot: native recovery and offset comparison, rather than snapshot
readiness alone, establish that the captured baseline is recoverable.

The rehearsal runs Apache's JVM Kafka 4.3.1 image against the clone, with only
loopback listeners, no service account token and denied network ingress and
egress. It refuses missing or mismatched log identity, recovers the existing
metadata, lists both topics and all 150 partitions, reads one retained metric
record without printing its payload, and shuts down normally. Receipts remain
under `upgrade-proof-4.3.1` on the retained clone. Compare its topic IDs and
end offsets with the live baseline before changing the production image.
The completed Job also emits these bounded metadata receipts in its logs;
read them there without mounting the clone or exposing metric payloads.

The JVM image declares a volume at `/var/lib/kafka/data`. Explicitly mount
the existing PVC `data` subdirectory at that exact path in both the rehearsal
and production Pod; mounting only `/var/lib/kafka` lets the image volume hide
the existing logs. The initial rehearsal stopped at the missing-identity
check before launching Kafka. Read-only inspection at a different mount path
confirmed the clone retains the original disk identity and all 150 partitions.

## Rollout and acceptance

After recovery passes, upgrade the existing broker to `apache/kafka:4.3.1`,
preserving its security identity and PVC. Use the JVM image because Apache
documents the native image as experimental. Set the original `CLUSTER_ID`
explicitly, provide a writable log directory and a bounded JVM heap, and
allow a 120-second graceful shutdown. Replace the temporary `OnDelete`
maintenance hold with normal StatefulSet rolling updates through GitOps.

The singleton broker has a brief ingest interruption during restart. Keep
remote-write collectors running so their queues and WALs can retry. Verify
the same PVC UID, cluster/disk identity, topic IDs, 150 healthy partition
leaders/replicas/ISR, nonregressing offsets and increasing new offsets.
Require fresh Mimir samples, historical queries, healthy ingest rings and
collector queues draining without discarded samples. Then advance Kafka
features to release 4.3 using the native CLI and repeat metadata and query
checks. Feature advancement prevents a binary downgrade to 4.1; keep the
snapshot and restore receipts.

If startup fails before feature advancement, restore the previous image on
the same PVC through GitOps. Do not substitute the snapshot for the live PVC
without accounting for writes received after snapshot creation. Retain all
logs and the clone while diagnosing recovery.

Sources: [Kafka 4.3 upgrades](https://kafka.apache.org/43/getting-started/upgrade/)
and [official Docker images](https://kafka.apache.org/43/getting-started/docker/).
