# Jangar Implementation Requirements

This document defines the concrete API, database schema, and controller responsibilities
required to implement the primitives in production.

## 1) API surface

### Agents

- `POST /v1/agents`
- `GET /v1/agents/{id}`
- `POST /v1/agent-runs`
- `GET /v1/agent-runs/{id}`
- `GET /v1/agent-runs?agentId=...`

### Memory

- `POST /v1/memories`
- `GET /v1/memories/{id}`
- `POST /v1/memory-queries`

### Orchestration

- `POST /v1/orchestrations`
- `GET /v1/orchestrations/{id}`
- `POST /v1/orchestration-runs`
- `GET /v1/orchestration-runs/{id}`

### Common

- `GET /v1/runs/{id}` (aggregate AgentRun + OrchestrationRun)

### Idempotency

All POST endpoints require `Idempotency-Key` and map to `deliveryId` in spec.

## 2) Database schema (jangar-db)

### 2.1 Tables

```sql
CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name text NOT NULL,
  delivery_id text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL,
  external_run_id text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_delivery_id_idx ON agent_runs(delivery_id);

CREATE TABLE IF NOT EXISTS memory_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_name text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL,
  connection_secret jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orchestration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  orchestration_name text NOT NULL,
  delivery_id text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL,
  external_run_id text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS orchestration_runs_delivery_id_idx ON orchestration_runs(delivery_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## 3) Controller responsibilities

Jangar must implement:

- CRD creation + updates (Agent, AgentRun, Memory, Orchestration)
- Status reconciliation (watch provider resources; optional resync interval)
- Policy enforcement (budgets, approvals, secrets)
- Retry + idempotency
- Audit log emission
- Supporting primitives reconciliation (Tool, ApprovalPolicy, Budget, SecretBinding, Signal, SignalDelivery, Schedule, Artifact, Workspace)
- Schedule execution via native Kubernetes CronJobs (no vendor workflows)
- Workspace provisioning via PVCs (status reflects PVC phase)

## 4) Provider watchers

- Native workflow runtime: watch `Job` status for AgentRun/ToolRun execution
- CNPG: read secrets and cluster status
- NATS/Kafka: ingest runtime events

## 5) Security

- Enforce allowlist of service accounts and secrets
- Persist every policy decision in `audit_events`

## 6) Related docs

- `docs/jangar/argo-only-judge-mode.md`
