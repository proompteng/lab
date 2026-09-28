# Incident Report: Galactic Node Disruption, Kafka Recovery, Ceph Backfill, And Torghut Degradation

- **Date**: 2026-06-27 UTC
- **Detected by**: Argo CD, Kubernetes pod state, Kafka broker logs, Torghut readiness failures
- **Reported by**: gregkonush
- **Primary services affected**: Kafka, Torghut Hyperliquid feed/runtime, Torghut websocket
- **Secondary services affected during recovery**: Rook Ceph, media probes, Forgejo readiness, KubeVirt/Saigak GPU passthrough, short-lived CronJobs
- **Severity**: High for Kafka-dependent trading and market-data paths
- **Status at write time**: Infrastructure recovery completed; trading-proof verification still blocked by account/fill state

## Summary

The cluster had a node-level disruption that restarted or disrupted workloads across `turin` and `talos-192-168-1-194`.
The incident presented as many stale `Completed` and `Error` pods, Argo CD degraded apps, and downstream Torghut services
returning readiness `503`.

The main active blocker was Kafka recovery, not Torghut application code. Kafka broker pool `pool-b` had brokers that were
running but below useful replication health while broker data logs replayed. Torghut producers then failed on Kafka writes
with `NOT_ENOUGH_REPLICAS` because live topics still had insufficient in-sync replicas for `min.insync.replicas=2`.

Rook Ceph was also degraded and backfilling after the node event, but recovered to `HEALTH_OK`. The media stack was
checked separately and was healthy after the stale pod cleanup.

Kafka, Ceph, and the Torghut Hyperliquid feed/runtime deployments recovered. The remaining unresolved item is not
infrastructure readiness: `torghut-hyperliquid-runtime-proof-verifier` still fails because `/trading/loop/status`
reports zero recent fills and position reconciliation is incomplete. That should not be hidden by weakening the verifier.

## Impact

- `Application/kafka` was `Synced` but `Degraded`.
- `torghut-hyperliquid-feed`, `torghut-hyperliquid-runtime`, and `torghut-ws` were unavailable or progressing.
- Torghut readiness stayed false because Kafka write/readiness gates were false.
- Proof-verifier CronJobs continued to create failed terminal pods while runtime readiness was broken.
- Stale terminal pods made namespace readback noisy and hid the active blockers.
- Ceph reported degraded objects and undersized/degraded placement groups while backfill was running.
- `saigak` remained pending for a separate GPU passthrough issue and was not part of the Kafka/Torghut blocker.

## User-Facing Symptom

The cluster looked partially healthy from some surfaces:

- most pods were running,
- Argo sync was green for many apps,
- media app status checks passed,
- Forgejo recovered,
- and Kafka pods eventually showed `Running`.

Those surfaces were incomplete. The real failure was request-path and producer-path health: Kafka could not maintain
enough ISR for live Torghut topics, so Torghut producers and readiness checks failed.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| 07:00-07:15 | Cluster showed many stale `Completed` and `Error` pods across namespaces after node disruption. |
| 07:10-07:20 | Argo CD showed `kafka` `Synced/Degraded`, `rook-ceph` `OutOfSync/Degraded`, and Torghut apps `Progressing` or `Degraded`. |
| 07:20-07:35 | Stale terminal pods were removed with Kubernetes phase selectors only; no PVCs, queues, app pods, or media files were deleted. |
| 07:35-07:45 | Kafka logs showed broker startup recovery and controller heartbeat/request timeouts. Torghut logs showed readiness `503` and Kafka write failures. |
| 07:43 | `kafka-pool-b-5` completed log replay and reached `Kafka Server started`. |
| 07:45 | `kafka-pool-b-3` was still replaying broker data logs, around `316/461` partitions completed. |
| 07:51 | Strimzi rolled `kafka-pool-b-3` because a non-dynamic reconfiguration required restart, resetting b3 replay progress. |
| 07:52+ | `kafka-pool-b-3` began replaying from the start again; Kafka remained degraded until replay and ISR catch-up finished. |
| 08:30 | Strimzi reconciliation was paused live to prevent another broker roll while `kafka-pool-b-3` completed recovery. |
| 08:34 | `kafka-pool-b-3`, `kafka-pool-b-4`, and `kafka-pool-b-5` were all Ready; Strimzi was unpaused. |
| 08:35 | Kafka topic checks returned no under-replicated or unavailable partitions. |
| 08:37-08:39 | `torghut-hyperliquid-feed` was restarted after Kafka ISR recovered; feed and runtime readiness returned `200`. |
| 08:50 | Ceph reported `HEALTH_OK`; terminal failed/succeeded pods were cleaned. |

## Root Cause

The immediate root cause was node-level disruption that forced Kafka broker recovery while the cluster was also recovering
storage and API/CSI surfaces.

The durable root cause is operational: Kafka recovery was allowed to run while Strimzi still had a pending non-dynamic
configuration reconciliation. Strimzi then rolled `kafka-pool-b-3` during broker log replay:

```text
Rolling Pod kafka-pool-b-3/3 due to [Pod needs to be restarted, because reconfiguration cannot be done dynamically]
```

That reset b3 startup progress and prolonged the period where live topics had too few in-sync replicas.

## Contributing Factors

- Kafka `pool-b` stores broker data on Ceph RBD, so recovery speed depends on RBD and node health.
- Broker data replay involved hundreds of partitions per broker, including large Hyperliquid and simulation topics.
- Active controller events were slow while brokers were reconnecting and recovering.
- Strimzi reconciliation was not paused during emergency broker replay.
- Proof-verifier CronJobs kept emitting failed terminal pods every five minutes while the runtime was known unhealthy.
- Node event fallout also produced many unrelated transient probe failures, which polluted diagnosis.

## What Was Not The Root Cause

- Torghut code was not the first failure. Torghut was downstream of Kafka quorum/ISR failure.
- Forgejo was not an active blocker after recovery checks.
- Media was not an active blocker after `bun run media:status -- --context galactic-lan` reported the `home-media` app,
  media pods, PVCs, ExternalSecrets, and Tailscale frontends healthy.
- Saigak GPU passthrough was a separate legacy GPU scheduling/configuration issue and did not block Kafka or Torghut.
- Ceph was degraded, but it was actively backfilling and improving during the observed window.

## Recovery Actions Taken

1. Verified current repo and cluster state before changing anything.
2. Removed stale terminal pods only:

```bash
kubectl --context galactic-lan delete pod -A --field-selector=status.phase=Failed
kubectl --context galactic-lan delete pod -A --field-selector=status.phase=Succeeded
```

3. Verified `home-media` separately with the repo status tool.
4. Checked Argo CD health for all non-healthy applications.
5. Checked Ceph health from `rook-ceph-tools`; recovery was progressing and degraded object count was falling.
6. Checked Kafka broker pod readiness, Strimzi status, broker logs, controller logs, and downstream Torghut logs.
7. Avoided restarting Torghut while Kafka topics still lacked enough ISR.
8. Identified the Strimzi-triggered b3 roll as the reason broker replay progress reset.
9. Paused Strimzi reconciliation while `kafka-pool-b-3` finished replay, then unpaused after all pool-b brokers were Ready.
10. Verified Kafka under-replicated and unavailable partition checks returned no active partitions.
11. Restarted only `torghut-hyperliquid-feed` after Kafka was healthy; runtime recovered from fresh feed-derived data.
12. Verified `torghut-hyperliquid-runtime` `/readyz` returned `200` with fresh TA/candle dependencies.
13. Verified Ceph recovered to `HEALTH_OK`.
14. Cleaned terminal pods and failed proof-verifier Job history after the live blockers were classified.

## Current Verification Checklist

Do not mark infrastructure recovery complete until all of these are true:

```bash
kubectl --context galactic-lan -n kafka get kafka,kafkanodepool,pods -o wide
kubectl --context galactic-lan -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl --context galactic-lan get applications.argoproj.io -n argocd kafka torghut torghut-hyperliquid-feed torghut-hyperliquid-runtime torghut-options
kubectl --context galactic-lan -n torghut get deploy torghut-hyperliquid-feed torghut-hyperliquid-runtime torghut-ws
```

Required final state:

- `Kafka/kafka` is `Ready=True`.
- `Application/kafka` is `Synced/Healthy`.
- `kafka-pool-b-3`, `kafka-pool-b-4`, and `kafka-pool-b-5` are all `1/1 Ready`.
- Kafka under-replicated partition checks return zero active under-replicated partitions for live topics.
- Torghut Hyperliquid feed/runtime and websocket deployments are available.
- Torghut logs no longer show fresh `NOT_ENOUGH_REPLICAS`.
- Ceph is either `HEALTH_OK` or has only understood, improving backfill warnings.
- Stale terminal pods are cleaned after active blockers are resolved.

Observed final infrastructure state on 2026-06-27:

- `Kafka/kafka` was `Ready=True`.
- `kafka-pool-b-3`, `kafka-pool-b-4`, and `kafka-pool-b-5` were `1/1 Running`.
- Kafka under-replicated and unavailable partition checks returned empty output.
- `torghut-hyperliquid-feed` and `torghut-hyperliquid-runtime` deployments were `1/1` Ready.
- `torghut-hyperliquid-runtime` `/readyz` returned `200`.
- Ceph reported `HEALTH_OK` with zero degraded objects.
- Failed and succeeded terminal pods were removed.

Do not mark trading proof restored until these additional verifier blockers are resolved:

- `hyperliquid_recent_fills_below_floor`
- `hyperliquid_position_reconciliation_missing`

The proof-verifier CronJob should continue to expose those blockers. Do not lower `--min-fills`, reduce
`--required-passes`, or otherwise make the verifier pass without actual restored proof.

## Recommended Safe Recovery Order

1. Let broker log replay finish unless the broker is clearly stuck or crash-looping.
2. If Strimzi has pending restarts while a broker is replaying, pause reconciliation before it rolls another recovering broker:

```bash
kubectl --context galactic-lan -n kafka annotate kafka kafka strimzi.io/pause-reconciliation=true --overwrite
```

3. Unpause only after all brokers are ready and ISR has recovered:

```bash
kubectl --context galactic-lan -n kafka annotate kafka kafka strimzi.io/pause-reconciliation- --overwrite
```

4. Restart Torghut producers only after Kafka is healthy or after live topic ISR is verified:

```bash
kubectl --context galactic-lan -n torghut rollout restart deploy/torghut-hyperliquid-feed deploy/torghut-hyperliquid-runtime deploy/torghut-ws
```

5. Clean terminal pods after the real blocker is resolved:

```bash
kubectl --context galactic-lan delete pod -A --field-selector=status.phase=Failed
kubectl --context galactic-lan delete pod -A --field-selector=status.phase=Succeeded
```

6. After infrastructure readiness is recovered, treat proof-verifier failures as trading/account-state failures and
   inspect `/trading/loop/status` before changing CronJob behavior.

## Preventive Actions

1. Add an operational guardrail to pause Strimzi reconciliation during emergency Kafka broker replay if a pod is already
   recovering large data logs and a pending non-dynamic restart is detected.
2. Add a Kafka recovery status command that reports broker replay progress, Strimzi pending rolls, under-replicated
   partitions, and downstream producer readiness in one output.
3. Reduce Kafka recovery surface by retiring or compacting stale simulation topics that do not need live retention.
4. Add alerts for:
   - Strimzi rolling a broker while another broker is unready,
   - repeated `NOT_ENOUGH_REPLICAS` on live Torghut topics,
   - broker replay progress resetting,
   - and proof-verifier CronJob failures while runtime readiness is false.
5. Limit failed CronJob history and add TTL for verifier jobs so known downstream failures do not accumulate stale pod
   noise.
6. Decide whether `saigak` should be migrated to the current GPU scheduling path or removed from steady-state health checks.
7. Keep Ceph and Kafka recovery runbooks separate; Ceph backfill can be a contributing condition without being the
   immediate Kafka/Torghut root cause.

## Lessons Learned

- A pod becoming `Running` is not Kafka recovery proof. ISR and producer-path writes are the proof.
- A cleanup pass that removes terminal pods can make the truth visible, but it does not fix active controllers, brokers, or apps.
- During Kafka recovery, Strimzi reconciliation can be actively harmful if it rolls a broker that is still replaying logs.
- Torghut should not be restarted repeatedly until Kafka is ready to accept writes.
- Separate stale noise from active blockers before declaring anything fixed.

## References

- [Kafka Broker Disk-Full Recovery And Dependent Service Bring-Up](2026-06-20-kafka-broker-disk-full-and-service-recovery.md)
- [Kafka KRaft Recovery Stall, ArgoCD Degradation, and Strimzi Hardening](2026-03-09-kafka-kraft-recovery-stall-and-strimzi-hardening.md)
- [Kafka Broker Storage Recovery Runbook](../runbooks/kafka-broker-storage-recovery.md)
