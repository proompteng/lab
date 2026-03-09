# Incident Report: Kafka KRaft Recovery Stall, ArgoCD Degradation, and Strimzi Hardening

- **Date**: 9 Mar 2026 (UTC)
- **Detected by**: Argo CD app `kafka` reported `Synced` but `Degraded`; KafkaUser resources remained `NotReady`
- **Reported by**: gregkonush
- **Services Affected**: Kafka cluster (`kafka` namespace), Strimzi entity/user operations, dependent Kafka producers/consumers using SCRAM users
- **Severity**: High (shared Kafka control plane degraded; user/operator reconciliation stalled)

## Impact Summary

- Argo CD application `kafka` remained `Degraded` even while sync status stayed `Synced`.
- All Kafka brokers stayed `0/1 Ready` during the incident window and repeatedly returned readiness `503` with `brokerState is 1`.
- All Strimzi `KafkaUser` resources in namespace `kafka` remained `NotReady` with `ScramShaCredentialsCache is not ready!`.
- Kafka broker registration and metadata catch-up were intermittently successful, but broker unfencing and steady-state readiness did not complete.
- User-facing risk: producers and consumers using shared SCRAM users could not rely on healthy broker availability or normal Strimzi user reconciliation.

## User-Facing Symptom

From the GitOps surface, Kafka looked partially healthy: Argo CD showed no drift, the Strimzi operator was running, and Kafka pods were not crash-looping. In practice, the cluster was unhealthy because brokers were stuck in long startup recovery, controller-path heartbeats were timing out during that recovery, and the entity operator could not reconcile Kafka users.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 2026-03-09 07:30 | KafkaUsers observed `NotReady` with `ScramShaCredentialsCache is not ready!`; Argo CD app `kafka` reported `Degraded`. |
| 2026-03-09 07:30-07:58 | Live broker/controller logs showed repeated KRaft instability: no active controller, broker registration timeouts, duplicate broker registration, and multi-second `writeNoOpRecord` controller stalls. |
| 2026-03-09 07:58 | Initial emergency mitigation widened KRaft timeout headroom in the live Kafka CR and generated broker ConfigMaps, then brokers were restarted to break duplicate-registration deadlock. |
| 2026-03-09 07:59-08:00 | All three brokers successfully registered again, but remained fenced and unreadable (`brokerState is 1`). |
| 2026-03-09 08:00-08:10 | Brokers continued replaying hundreds of partitions (`412`, `413`, `424` logs respectively). Recovery progressed, but heartbeats still timed out during recovery windows and brokers never unfenced. |
| 2026-03-09 08:10 | Controller performance evidence became explicit: `writeNoOpRecord` and `processBrokerHeartbeat` events reached ~20s; the last 60s average controller event time reached ~36s; the slowest controller event exceeded ~87s. |
| 2026-03-09 08:13 | Strimzi operator logs confirmed at least one manually added config key, `controller.quorum.request.timeout.ms`, was forbidden and ignored. |
| 2026-03-09 08:15 | Brokers on a fresh boot successfully caught up metadata high-water mark again before data log replay started, proving that `MetadataLoader ... don't know the high water mark yet` was a transient bootstrap stage rather than the lasting root cause. |
| 2026-03-09 08:18 | Even after widening heartbeat timeout headroom to `120000ms` in the live broker config, broker heartbeats still timed out once recovery stalls exceeded two minutes on the active controller path. |
| 2026-03-09 08:20-08:30 | Durable GitOps remediation was rewritten onto supported Strimzi fields: Kafka probe headroom, KafkaNodePool resource requests, and only allowed controller quorum timeout settings were kept in the repo manifest. |

## Root Cause

This was a slow-recovery and control-plane starvation incident on a combined KRaft broker/controller pool.

Primary causes:

1. **Combined broker and controller roles on the same Ceph-backed node pool**
   - `KafkaNodePool/pool-a` runs both `controller` and `broker` roles on all three replicas.
   - During restart, each node had to replay both metadata/control-plane work and hundreds of broker logs on the same pod and PVC.

2. **Recovery throughput on `rook-ceph-block` storage was too slow for KRaft lease maintenance**
   - Representative log loads during the incident took tens of seconds:
     - `github.webhook.events-1` load in `46219ms`
     - `github.webhook.events-2` load in `41571ms`
     - `torghut.trades.v1-2` load in `37222ms`
   - Controller-path writes and heartbeat processing were also slow:
     - `writeNoOpRecord` ~`20023ms`
     - `processBrokerHeartbeat` ~`20020ms`
     - slowest controller event in a 60s window: ~`87634ms`

3. **Kafka pods had no explicit CPU or memory requests**
   - `KafkaNodePool/pool-a` had `resources: {}` in the live pod spec during the incident.
   - That left recovery performance dependent on opportunistic scheduling and storage latency rather than guaranteed Kafka runtime headroom.

## Contributing Factors

- **Large recovery surface per broker**
  - Brokers were reopening `412`, `413`, and `424` logs respectively, including many small simulation topics plus internal `__consumer_offsets` and `__transaction_state` partitions.
- **Unsupported Strimzi config keys complicated mitigation**
  - Emergency live timeout surgery helped characterize the failure mode, but it was not a valid durable fix.
  - The Strimzi operator explicitly logged that `controller.quorum.request.timeout.ms` was forbidden and ignored.
- **Stale or misleading status surfaces**
  - Kafka CR status lagged during the incident, and Argo CD only surfaced downstream `Degraded` state rather than the underlying KRaft recovery stall.
- **Combined role topology amplified latency sensitivity**
  - The active controller was simultaneously handling KRaft metadata work, broker-heartbeat processing, and local broker log recovery on the same pod.

## What Was Not the Root Cause

- The repeated `Recovering unflushed segment` and producer-state rebuild lines were not corruption by themselves; they were expected startup recovery work.
- The repeated `MetadataLoader ... we still don't know the high water mark yet` lines were transient bootstrap noise on this boot; brokers later logged that metadata loading had caught up to the current high-water mark.
- Kubernetes restart loops were not the primary ongoing failure during the observed window; the brokers had `0` restarts while still remaining unready.

## Evidence

- Argo CD degraded state:
  - `kubectl get applications.argoproj.io -n argocd kafka -o json | jq '{health: .status.health.status, sync: .status.sync.status}'`
  - Result during incident: `health=Degraded`, `sync=Synced`
- KafkaUser failure surface:
  - `kubectl get kafkauser.kafka.strimzi.io -n kafka -o json | jq ...`
  - All users reported `NotReady` with `ScramShaCredentialsCache is not ready!`
- Broker readiness:
  - `curl http://localhost:8080/v1/ready/`
  - Repeated result: `Readiness failed: brokerState is 1`, `HTTP 503`
- Slow controller-path evidence:
  - `Exceptionally slow controller event writeNoOpRecord ... took 20023 ms`
  - `Exceptionally slow controller event processBrokerHeartbeat ... took 20020 ms`
  - `270 controller events ... average 36443.29 ms each ... slowest ... 87634.25 ms`
- Slow broker recovery evidence:
  - `Completed load of Log(... github.webhook.events-1 ...) ... in 46219ms`
  - `Completed load of Log(... github.webhook.events-2 ...) ... in 41571ms`
  - `Completed load of Log(... torghut.trades.v1-2 ...) ... in 37222ms`
- Strimzi config restriction evidence:
  - Operator warning: `Configuration option "controller.quorum.request.timeout.ms" is forbidden and will be ignored`

## Remediation Applied

### Emergency live mitigation

1. Verified the failure surface in-cluster with `kubectl` and broker/controller logs.
2. Applied temporary live KRaft timeout headroom to the Kafka CR and generated broker ConfigMaps to reduce immediate registration churn.
3. Restarted brokers to clear duplicate-registration and initial no-controller loops.
4. Repeated live validation to distinguish:
   - metadata catch-up,
   - broker registration,
   - broker unfencing,
   - and slow data-log recovery.

### Durable GitOps remediation

1. Replaced unsupported Kafka config changes in Git with supported Strimzi fields in [`argocd/applications/kafka/strimzi-kafka-cluster.yaml`](../../argocd/applications/kafka/strimzi-kafka-cluster.yaml).
2. Added Kafka probe headroom:
   - `livenessProbe.initialDelaySeconds: 180`
   - `livenessProbe.periodSeconds: 15`
   - `livenessProbe.timeoutSeconds: 10`
   - `livenessProbe.failureThreshold: 40`
   - `readinessProbe.initialDelaySeconds: 60`
   - `readinessProbe.periodSeconds: 15`
   - `readinessProbe.timeoutSeconds: 10`
   - `readinessProbe.failureThreshold: 60`
3. Added `KafkaNodePool.spec.resources.requests`:
   - `cpu: 2000m`
   - `memory: 4Gi`
4. Kept only Strimzi-supported controller quorum tuning in `spec.kafka.config`:
   - `controller.quorum.election.timeout.ms: 60000`
   - `controller.quorum.fetch.timeout.ms: 180000`

## Current Verified State (At End of This Session)

- Kafka app remained `Synced` but `Degraded`.
- Brokers were still `0/1 Ready` and continued replaying logs.
- Broker readiness still returned `HTTP 503` with `brokerState is 1`.
- KafkaUsers remained `NotReady`.
- The current boot was materially more stable than the earlier failure mode:
  - metadata loader catch-up completed successfully,
  - immediate duplicate-registration loops were cleared,
  - and brokers were steadily advancing through log recovery.
- However, recovery throughput was still too slow to declare incident resolved during this session.

## Preventive Actions

1. Split `controller` and `broker` roles into separate `KafkaNodePool` resources so control-plane quorum work is not contending with broker log replay on the same pods.
2. Move the broker pool to faster or less contended storage than the current `rook-ceph-block` path, or otherwise improve storage latency guarantees for Kafka PVCs.
3. Keep explicit Kafka CPU and memory requests in Git so broker recovery does not depend on best-effort scheduling.
4. Reduce recovery surface by retiring low-value simulation topics and unnecessary partitions.
5. Add alerting on:
   - sustained `brokerState != RUNNING`,
   - Strimzi `KafkaUser` `NotReady`,
   - controller event latency,
   - and KRaft heartbeat/request timeout frequency.
6. Treat direct broker ConfigMap edits as emergency-only and backport any valid long-term fix to supported Strimzi fields immediately.

## Lessons Learned

- KRaft recovery problems are easy to misread as harmless startup noise unless controller latency and heartbeat paths are checked at the same time.
- GitOps health can stay misleadingly green on sync while the application remains operationally degraded.
- Break-glass Kafka config edits can help isolate a live failure mode, but they are not a substitute for understanding what Strimzi will actually honor.
- Combined broker/controller topology on slow storage is fragile under restart load.

## References

- [docs/incidents/2025-11-01-kafka-quorum-outage.md](2025-11-01-kafka-quorum-outage.md)
- [docs/incidents/2025-12-20-longhorn-upgrade-kafka-failure.md](2025-12-20-longhorn-upgrade-kafka-failure.md)
- [argocd/applications/kafka/strimzi-kafka-cluster.yaml](../../argocd/applications/kafka/strimzi-kafka-cluster.yaml)
