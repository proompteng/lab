# Torghut System Snapshot Design (Human Review)

## Purpose
Define what a "system snapshot" means for Torghut, how to interpret it, and how to use it for operational decisions.

This document is the design contract behind:
- `current-state-snapshot-2026-02-12.md`
- `system-state-assessment-runbook.md`

## Design Goals
- Single-page operational truth for current state.
- Clear separation between observed facts and interpretation.
- Fast triage path from symptom to affected layer.
- Human-review friendly structure with diagrams and explicit probes.

## Snapshot Model
The snapshot is a four-plane model:
- Control plane: orchestration and rollout state.
- Compute plane: workload readiness and revisions.
- Data plane: storage health, freshness, and throughput.
- Decision plane: trading loop behavior and rejection composition.

```mermaid
flowchart LR
  subgraph "Control Plane"
    A["Argo CD App"]
    B["Knative Service (torghut)"]
    C["FlinkDeployment (torghut-ta)"]
    D["CNPG Cluster (torghut-db)"]
    E["ClickHouseInstallation"]
  end

  subgraph "Compute Plane"
    F["torghut Pod"]
    G["torghut-ws Pod"]
    H["torghut-ta JobManager + TaskManagers"]
    I["torghut-lean-runner Pod"]
  end

  subgraph "Data Plane"
    J["Postgres (trade_decisions, executions, snapshots)"]
    K["ClickHouse (ta_signals, ta_microbars)"]
    L["Jangar Symbols API"]
  end

  subgraph "Decision Plane"
    M["/trading/status + /trading/metrics"]
    N["Risk reasons distribution"]
    O["Execution state distribution"]
  end

  A --> B
  B --> F
  C --> H
  D --> J
  E --> K
  G --> H
  H --> K
  F --> J
  F --> M
  L --> F
  L --> G
  J --> N
  J --> O
```

## Assessment Workflow Design
The workflow is intentionally staged so failures are localized quickly.

```mermaid
sequenceDiagram
  participant Op as Oncall
  participant K8s as Kubernetes API
  participant Tor as torghut service
  participant WS as torghut-ws
  participant TA as torghut-ta (Flink)
  participant PG as Postgres
  participant CH as ClickHouse
  participant Jg as Jangar symbols API

  Op->>K8s: Check control-plane objects\n(ksvc, flinkdeployment, cnpg, CHI, Argo app)
  K8s-->>Op: Ready/degraded state
  Op->>Tor: GET /trading/status + /trading/metrics
  Tor-->>Op: Runtime mode, counters, last_error
  Op->>Jg: Fetch symbols
  Jg-->>Op: Current symbol universe
  Op->>PG: Query decision/execution/snapshot tables
  PG-->>Op: Status mix + risk reasons
  Op->>CH: Query table freshness + replica status
  CH-->>Op: lag + row volumes + replica queue
  Op->>WS: Verify ingestion pod health and Kafka produce logs
  WS-->>Op: Ingestion continuity evidence
  Op->>TA: Verify checkpoint progression
  TA-->>Op: Processing continuity evidence
```

## State Classification Logic

```mermaid
flowchart TD
  S["Start Assessment"] --> C1{"Control plane healthy?"}
  C1 -- "No" --> R["RED: platform incident"]
  C1 -- "Yes" --> C2{"Data fresh\n(CH lag acceptable)?"}
  C2 -- "No" --> R2["RED: data pipeline incident"]
  C2 -- "Yes" --> C3{"Trading loop running\nand no fatal error?"}
  C3 -- "No" --> R3["RED: service incident"]
  C3 -- "Yes" --> C4{"Rejection profile expected?"}
  C4 -- "No (unexpected spike,\nnew risk reason)" --> Y["YELLOW: policy/config investigation"]
  C4 -- "Yes" --> G["GREEN: continue operations"]
  Y --> C5{"Contains symbol_not_allowed spike?"}
  C5 -- "Yes" --> A1["Check strategy universe_symbols\nvs Jangar symbols"]
  C5 -- "No" --> A2["Investigate LLM/risk/execution policy changes"]
```

## Data Contract for a Snapshot Artifact
Each snapshot should capture:
- Metadata:
  - capture window (UTC),
  - operator identity,
  - command bundle version.
- Control plane facts:
  - ksvc revision + readiness,
  - Argo sync/health,
  - Flink/CNPG/ClickHouse operator status.
- Compute plane facts:
  - pod/deployment readiness and restart counts.
- Data plane facts:
  - Postgres table counts and recent status distribution,
  - ClickHouse row counts, freshness lag, and replica health.
- Decision plane facts:
  - `/trading/status` runtime posture,
  - top rejection reasons,
  - universe consistency verification.

## Interpretation Rules
- Snapshot facts are time-bound and must include exact UTC timestamps.
- Any inferred conclusion must be explicitly labeled as interpretation.
- If control plane availability is intermittent, confidence in all concurrent probes is reduced and must be noted.

## Review Checklist
- Are all four planes represented?
- Are timestamps explicit and recent?
- Are probe commands reproducible?
- Is drift called out (`OutOfSync`, manual patch risk)?
- Are next actions mapped to concrete owners?

## Relationship to Existing v1/v3 Docs
- v1 docs remain source of truth for component-level recovery runbooks.
- This v3 design defines the operational "snapshot grammar" used to summarize current state quickly for human reviewers.

