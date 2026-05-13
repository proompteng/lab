# SAG Technical Design

## Runtime Shape

SAG runs as one TanStack Start service in `services/sag`, deployed by Argo from `argocd/sag` to the `sag` namespace at `https://sag.proompteng.ai`.

Core components:

- Web/API service: task intake, UI, approval routes, audit export.
- CNPG Postgres: normalized state and append-only audit events.
- Policy engine: deterministic pre-action checks.
- Codex app-server rule translator: natural-language policy text to deterministic rule JSON.
- Kubernetes reader: read-only service account for live AgentRuns and Jobs.
- Internal GraphQL endpoint: `/api/internal/graphql`, backed by persisted SAG records.
- Legacy endpoint: `/api/internal/legacy`, a line-oriented feed parsed by the connector layer.

## Data Model

The backend persists first-class primitives instead of one JSON document:

- `sag_identities`
- `sag_connectors`
- `sag_policies`
- `sag_tasks`
- `sag_plan_steps`
- `sag_connector_calls`
- `sag_approvals`
- `sag_agent_runs`
- `sag_rule_messages`
- `sag_audit_events`

`sag_state` remains as a compatibility snapshot during migration, but the product reads and writes the normalized tables.

## Workflow

1. User submits natural-language intent to `/api/tasks`.
2. Server resolves identity from trusted headers/default environment, not from request body.
3. Planner creates ordered steps: SQL policy context, Kubernetes REST AgentRun read, internal GraphQL audit graph, legacy feed parser, and optional guarded mutation step.
4. Policy evaluates each step before execution.
5. Block rules stop the task. Approval rules create `sag_approvals` records and leave the task waiting.
6. Allowed steps execute connector code and write `sag_connector_calls`.
7. Every received, planned, allowed, blocked, approved, and executed action writes `sag_audit_events`.

## Connector Contract

Each connector has an explicit operation, target, trust boundary, evidence payload, request hash, duration, and audit event.

Implemented connectors:

- SQL: reads live CNPG table counts for policy/audit context.
- REST: calls the Kubernetes API through the in-cluster service account to read live AgentRuns.
- GraphQL: serves and queries a real internal graph endpoint over persisted SAG tasks/events/calls.
- Legacy: parses a pipe-delimited status feed sourced from live AgentRun metadata.
- Kubernetes: evaluates AgentRun runtime authority.
- Policy: evaluates rules and approvals.
- Audit: writes and exports JSONL.

## Auth And Security

Roles:

- `greg`: operator and approver.
- `ops`: operator and approver.
- `audit`: read-only.

Production identity integration maps OIDC/SAML/LDAP headers to these roles. The current service already enforces permissions server-side and ignores caller-supplied actor bodies for task, rule, and approval routes.

Codex app-server auth is mounted from `codex-auth` in namespace `sag` through `argocd/sag/codex-auth-sealedsecret.yaml`. The container sets:

- `CODEX_HOME=/home/bun/.codex`
- `CODEX_AUTH=/home/bun/.codex/auth.json`
- `SAG_CODEX_BINARY=codex`

## Audit And Redaction

SAG redacts secret-like keys and values before storing evidence. Audit records include:

- timestamp,
- identity,
- connector,
- operation,
- target,
- status,
- policy,
- request hash,
- correlation id,
- duration,
- redacted evidence.

`/api/events/export` returns JSONL for panel review and compliance evidence.

## Isolation Path

Today SAG runs as a hardened non-root Kubernetes deployment with runtime default seccomp and read-only scoped service account permissions. For higher-risk customer deployments, the next isolation layer is a Kubernetes `RuntimeClass` backed by gVisor/runsc. Kubernetes uses RuntimeClass to select a runtime per Pod, and gVisor places an application kernel between the workload and host kernel.

## Validation

Local gates:

```sh
bun run --filter @proompteng/sag test
bun run --filter @proompteng/sag tsc
bun run --filter @proompteng/sag build
```

Live gates:

```sh
curl -fsS https://sag.proompteng.ai/api/health
curl -fsS -X POST https://sag.proompteng.ai/api/tasks \
  -H 'content-type: application/json' \
  --data '{"text":"Inspect live agent runs, read SQL policy state, query audit graph, and parse the legacy feed"}'
curl -fsS https://sag.proompteng.ai/api/events/export
```
