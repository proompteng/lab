# Incident Report: Kafka User Reconciliation Failure From Ceph Recovery Pressure

- **Date**: 2026-07-03 UTC
- **Detected by**: Argo CD app `kafka`, Strimzi `KafkaUser` status, Kafka admin/quorum checks, Rook Ceph health
- **Reported by**: gregkonush
- **Services affected**: Kafka cluster in namespace `kafka`, Strimzi entity operator, SCRAM-backed Kafka clients
- **Contributing infrastructure**: Rook Ceph block storage, OSDs on `talos-192-168-1-85`
- **Severity**: High for Kafka-dependent services; Ceph remained a separate storage-risk surface after Kafka recovery

## Impact Summary

Argo CD showed `Application/kafka` as `Synced` but `Degraded` because all Strimzi `KafkaUser` resources were
`NotReady`. The Kafka user operator could not complete SCRAM credential reconciliation because its Kafka admin-client
requests timed out. Kafka broker pods were mostly running, but the control-plane/admin path was not reliable enough to
serve user reconciliation.

The incident was not caused by Qwen, Blackwell scheduling, or stale completed pods. Those were adjacent surfaces. The
active blocker was Kafka KRaft/controller latency under heavy Ceph recovery pressure.

## Root Cause

Rook Ceph recovery was configured too aggressively for a cluster that also served latency-sensitive Kafka RBD volumes.
The relevant live and GitOps settings were:

```text
osd_mclock_profile=high_recovery_ops
osd_max_backfills=32
osd_recovery_max_active=64
```

At the same time, Ceph reported slow BlueStore operations on OSDs hosted by `talos-192-168-1-85`:

```text
osd.3 observed slow operation indications in BlueStore
osd.5 observed slow operation indications in BlueStore
```

This caused KRaft/controller write latency, broker heartbeat/request timeouts, and Kafka admin-client timeouts. The
visible Argo CD symptom was `KafkaUser` degradation, but the failure was below Strimzi in the Kafka control-plane path.

## Five Whys

Five Whys analysis starts from the user-visible impact and repeatedly asks why the previous answer happened until the
chain reaches an actionable process or configuration failure. It is not a blame exercise, and the useful stopping point
can be fewer or more than exactly five questions.

1. **Why was the Argo CD `kafka` application degraded?**

   `KafkaUser` resources were `NotReady`, so Argo surfaced the Kafka application as unhealthy even though sync status
   was clean.

2. **Why were `KafkaUser` resources `NotReady`?**

   The Strimzi user operator could not complete SCRAM credential reconciliation because Kafka admin-client operations
   timed out.

3. **Why were Kafka admin-client operations timing out?**

   Kafka KRaft/controller and broker request paths were intermittently too slow to respond within admin-client timeouts.

4. **Why were Kafka control-plane request paths too slow?**

   Kafka metadata and broker state were on Ceph-backed PVCs while Ceph was running heavy recovery/backfill, and OSDs on
   `talos-192-168-1-85` were reporting slow BlueStore operations.

5. **Why did Ceph recovery starve latency-sensitive Kafka IO?**

   Rook Ceph was configured to favor recovery throughput over client latency with `high_recovery_ops`,
   `osd_max_backfills=32`, and `osd_recovery_max_active=64`, even though Kafka and database PVCs share the same RBD
   storage.

6. **Why was that configuration allowed to remain in place for shared Kafka/database storage?**

   The storage runbook and GitOps values did not encode a clear policy that recovery must favor client latency when
   Kafka or database PVCs are on the same Ceph cluster.

**Actionable root cause**: Ceph recovery policy was tuned for aggressive backfill instead of latency-sensitive shared
storage, and the incident documentation/runbook did not make that tradeoff explicit before recovery pressure reached
Kafka admin/control-plane paths.

## Contributing Factors

- Kafka broker and controller state lives on Ceph-backed PVCs.
- Ceph backfill/recovery competed with normal client IO on the same storage system.
- Slow OSDs on `talos-192-168-1-85` increased the latency impact.
- A stale earlier diagnosis about completed pods was not the live root cause during this recovery window.
- One attempted Kafka config key, `controller.quorum.request.timeout.ms`, was forbidden by Strimzi and was removed.
- Recovery included break-glass Kafka metadata-cache surgery, which is not routine SOP and should not be normalized.

## What Was Not The Root Cause

- Qwen or Blackwell GPU scheduling.
- Kafka application source drift.
- Kafka topic or KafkaUser manifest deletion.
- Argo CD sync failure; the app was synced while health was degraded.
- Completed historical pods in the Argo app tree during the later KafkaUser failure window.

## Recovery Actions

### Supported or routine actions

1. Verified current Argo CD health, `KafkaUser` conditions, broker pod placement, and Kafka admin/quorum behavior.
2. Removed a stale live Strimzi pause annotation from the Kafka CR:

```bash
kubectl -n kafka annotate kafka kafka strimzi.io/pause-reconciliation-
```

3. Forced a Strimzi reconciliation with `strimzi.io/manual-reconciliation`.
4. Scaled `kafka-entity-operator` down during broker/control-plane recovery, then restored it to one replica.
5. Used Strimzi manual rolling annotation for `kafka-pool-b-3`:

```bash
kubectl -n kafka annotate pod kafka-pool-b-3 strimzi.io/manual-rolling-update=true --overwrite
```

6. Throttled Ceph recovery to favor client latency:

```bash
ceph config set osd osd_mclock_profile high_client_ops
ceph config set osd osd_mclock_override_recovery_settings true
ceph config set osd osd_max_backfills 1
ceph config set osd osd_recovery_max_active 1
ceph config set osd osd_recovery_max_active_hdd 1
```

### Break-glass actions

1. Renamed local `__cluster_metadata-0` directories on affected Kafka pods after logs showed KRaft metadata-cache
   corruption or inconsistent local metadata state.
2. Moved those backup directories outside Kafka `log.dirs` after discovering that leaving backup directories under
   `log.dirs` caused Kafka `LogManager` startup failure because the backup directory names were not valid topic
   partition paths.

This was emergency recovery, not SOP. The routine path is broker rolling and validated Strimzi configuration, not manual
metadata-cache manipulation.

### Operator-induced secondary issue

`talos-192-168-1-85` was cordoned during recovery to keep new Kafka or storage-sensitive pods away from the node with
slow OSDs. That was too broad for Kafka restoration because it changed scheduling behavior for the entire node while the
node still ran many existing workloads.

The cordon was removed after review:

```bash
kubectl uncordon talos-192-168-1-85
```

Do not cordon a whole node as a Kafka recovery default. If node-level isolation is required, it must be explicit,
time-bound, communicated, and verified with workload placement before and after the change.

## Durable Mitigation

Ceph recovery should not run with `high_recovery_ops`, `osd_max_backfills=32`, and `osd_recovery_max_active=64` while
Kafka and database PVCs share the same RBD-backed storage. The intended GitOps mitigation is to favor client latency
during recovery:

```yaml
osd:
  bluestore_cache_autotune: "true"
  osd_mclock_profile: "high_client_ops"
  osd_mclock_override_recovery_settings: "true"
  osd_memory_target: "6442450944"
  osd_max_backfills: "1"
  osd_recovery_max_active: "1"
  osd_recovery_max_active_hdd: "1"
```

This report is documentation-only. The Ceph values change should be merged through the normal GitOps path if it is not
already present in the target branch.

## Final Verification

Kafka recovery was considered complete only after all of these checks passed:

```bash
kubectl -n kafka get kafka kafka
kubectl -n kafka get kafkauser
kubectl -n kafka get pods -o wide
kubectl -n kafka exec kafka-pool-a-0 -- \
  bash -lc 'timeout 30s /opt/kafka/bin/kafka-metadata-quorum.sh --bootstrap-server kafka-kafka-bootstrap:9093 describe --status'
kubectl -n kafka exec kafka-pool-a-0 -- \
  bash -lc 'timeout 30s /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka-kafka-bootstrap:9093 --describe --under-replicated-partitions'
argocd app get kafka --core
```

Verified recovered state:

- `Application/kafka`: `Synced`, `Healthy`
- `Kafka/kafka`: `Ready=True`
- all ten `KafkaUser` resources: `Ready=True`
- Kafka metadata quorum command returned cluster status
- under-replicated partition query returned empty output
- all broker pods were `Running`

Ceph was not fully healthy at Kafka closeout:

- Ceph still reported `HEALTH_WARN`
- `noout,noscrub,nodeep-scrub` flags remained set from prior operations
- OSD slow-operation warnings remained the storage-risk surface

## Follow-Up Actions

1. Merge the Ceph recovery throttle through GitOps if it is still only live state.
2. Keep Kafka restoration docs clear that `KafkaUser Ready=True` and Kafka admin/quorum checks are required proof; pod
   readiness alone is not enough.
3. Add or preserve alerting on `KafkaUser NotReady`, Kafka admin-client timeout rates, and KRaft controller event
   latency.
4. Review OSD health on `talos-192-168-1-85` before relying on it for latency-sensitive workloads.
5. Avoid node cordons as an implicit storage mitigation. Prefer workload-specific scheduling constraints or an explicit
   maintenance procedure.
6. Treat direct KRaft metadata-cache changes as break-glass with a written command log and post-action verification.

## Related Documents

- [Kafka KRaft Recovery Stall, ArgoCD Degradation, and Strimzi Hardening](2026-03-09-kafka-kraft-recovery-stall-and-strimzi-hardening.md)
- [Kafka Broker Disk-Full Recovery And Dependent Service Bring-Up](2026-06-20-kafka-broker-disk-full-and-service-recovery.md)
- [Galactic Node Disruption, Kafka Recovery, Ceph Backfill, And Torghut Degradation](2026-06-27-galactic-node-disruption-kafka-ceph-torghut-recovery.md)
- [Kafka Broker Storage Recovery Runbook](../runbooks/kafka-broker-storage-recovery.md)
- [Rook Ceph On Talos](../runbooks/rook-ceph-on-talos.md)
