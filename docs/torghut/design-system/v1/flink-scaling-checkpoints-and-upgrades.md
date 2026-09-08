# Flink Scaling, Checkpoints, and Upgrades

## Status

- Version: `v1`
- Last updated: **2026-02-08**
- Source of truth (config): `argocd/applications/torghut/**`

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Implemented/partially evolved: Dorvud WS/TA, Torghut ClickHouse/GitOps, and TA Flink deployments exist; exact topics/tables must be verified from current manifests/code.
- Matched implementation area: Market data, Kafka, Flink, ClickHouse, TA, and WS forwarding.
- Current source evidence:
  - `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderApp.kt`
  - `services/dorvud/technical-analysis-flink/src/main/kotlin/ai/proompteng/dorvud/ta/flink/FlinkTechnicalAnalysisJob.kt`
  - `argocd/applications/torghut/ws/deployment.yaml`
  - `argocd/applications/torghut/ta/flinkdeployment.yaml`
  - `argocd/applications/torghut/clickhouse/clickhouse-cluster.yaml`
- Design drift note: Data-plane diagrams can be directionally right while specific topic/table/runtime claims drift.


## Purpose

Document how to scale the TA Flink job safely, how checkpointing interacts with upgrades, and which knobs are safe to
change in production.

## Non-goals

- Operator installation and cluster-level Flink tuning.

## Terminology

- **Parallelism:** Number of parallel operator instances.
- **Task slots:** Execution slots per TaskManager.
- **Upgrade mode:** FlinkDeployment strategy (stateless, last-state, savepoint).

## Current production config (pointers)

- FlinkDeployment: `argocd/applications/torghut/ta/flinkdeployment.yaml`
- TA config: `argocd/applications/torghut/ta/configmap.yaml`

Key current values:

- `taskmanager.numberOfTaskSlots: "2"`
- TaskManagers: `replicas: 4`
- Job parallelism: `parallelism: 8`
- Upgrade mode: `stateless` (v1 current manifest)

## Scaling model

```mermaid
flowchart TD
  Partitions["Kafka partitions"] --> Parallelism["Flink parallelism"]
  Parallelism --> Slots["TaskManager slots"]
  Slots --> Resources["CPU/memory"]
  Resources --> Checkpoints["Checkpoint duration + stability"]
```

Guidance:

- Keep parallelism ≤ (taskmanagers \* slots) to avoid slot starvation.
- After increasing parallelism:
  - monitor checkpoint duration and backpressure,
  - validate ClickHouse sink capacity.

## Upgrade guidance (v1)

- Prefer savepoint/last-state upgrades when changing stateful operators or windowing logic.
- Stateless upgrades are acceptable for purely stateless changes but risk losing state.

## Failure modes and recovery

| Failure                      | Symptoms        | Detection                  | Recovery                                                     |
| ---------------------------- | --------------- | -------------------------- | ------------------------------------------------------------ |
| Checkpoints fail after scale | job instability | checkpoint failure metrics | revert scale; fix S3 creds/endpoint; restart with last-state |
| Backpressure increases       | lag grows       | watermark lag metrics      | increase resources; tune sinks; reduce parallelism           |

## Security considerations

- Checkpoint storage credentials are secrets; rotate carefully (see `v1/security-secrets-rotation.md`).

## Decisions (ADRs)

### ADR-33-1: Scale TA conservatively with checkpoint health as primary signal

- **Decision:** Treat checkpoint health as the primary “can we scale further?” signal.
- **Rationale:** Unhealthy checkpoints make recovery and correctness unreliable.
- **Consequences:** Scaling decisions are slower but safer.
