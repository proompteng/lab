# Cluster QoS and disruption budget audit — 2026-11-27

## Hardened

Pinned chart renders and live Pod QoS agreed on four BestEffort control-plane workloads. Each now has CPU and memory
requests and limits, so newly created Pods will be Burstable. Requests exceed the observed working sets; the limits
leave room for bursts. The `kubectl top pods --containers` snapshot was a sizing reference, not a peak measurement.

| Workload                                                                                            | Observed CPU / memory | CPU / memory request | CPU / memory limit |
| --------------------------------------------------------------------------------------------------- | --------------------- | -------------------- | ------------------ |
| [Sealed Secrets controller](../../argocd/applications/sealed-secrets/kustomization.yaml)            | 1m / 39Mi             | 50m / 64Mi           | 1 CPU / 256Mi      |
| [Kargo API, management controller, admission webhooks](../../argocd/applicationsets/helm-apps.yaml) | 1–16m / 80–83Mi each  | 100m / 128Mi each    | 1 CPU / 512Mi each |

Kargo's Helm ApplicationSet owns its Deployments. The [Kargo delivery overlay](../../argocd/applications/kargo/)
contains no Pod workloads and is unchanged.

## Intentionally unchanged

- **Auto Ontology:** PostgreSQL, backend, frontend, ingestion, and MCP are single-replica and already Burstable.
  The migration Jobs also have resource requests on their init containers.
- **NATS:** The three JetStream servers are Burstable. The chart's existing `maxUnavailable: 1` budget protects
  quorum. The BestEffort `nats-box` and Helm smoke-test Pod are diagnostic tools, not servers.
- **Restate:** The three servers already have requests and limits and retain their `minAvailable: 3` budget. The
  two-replica `tengri-run-reader` in the namespace belongs to the separate Tengri application, not the Restate overlay.
- **Kargo and Sealed Secrets:** The main Kargo controller already has a 40Gi memory request and limit. The periodic
  Kargo garbage collector and the Sealed Secrets web UI are not part of the serving control plane and remain unchanged.

No audited application-owned workload with multiple replicas lacked a budget. No singleton budget was added, since
`minAvailable: 1` would block voluntary eviction of its only Pod. Bayn, Agents, Observability, and ARC were excluded.

## Rollout and recovery

The changes follow the existing Argo CD sync policies with no dependency between the two rollouts. A singleton
replacement may briefly interrupt reconciliation or admission. After sync, check that all four Deployments return Ready,
their new Pods report `Burstable`, and none show scheduling failures or OOM kills. If a new resource setting causes
instability, revert the affected values through GitOps; do not change image pins or controller keys.
