# SAG Technical Design

## Architecture

SAG runs as one TanStack Start service in `services/sag`, deployed by Argo from `argocd/sag` to namespace `sag` at `https://sag.proompteng.ai`.

Core components:

- Web/API service for runs, approvals, policies, sources, and audit replay.
- CNPG Postgres for normalized state and append-only audit events.
- Planner that converts a request into ordered action steps.
- Policy gate that evaluates every step before execution.
- Source adapters for policy data, internal API, audit graph, operations feed, workload control, and audit log.
- Codex app-server policy translator mounted with sealed auth.

## Data Model

The persisted model remains normalized:

- identities;
- sources;
- policies;
- requests/tasks;
- action steps;
- source calls;
- approvals;
- protected workloads;
- audit events.

`/api/snapshot` returns both raw persisted records and a server-derived display model:

- `AgentActionRun`;
- `AgentActionStep`;
- `ActionEvidence`.

The UI renders the display model so user-facing screens do not expose storage identifiers, manifests, regexes, hashes, or raw payloads.

## Workflow

1. User submits a request to `/api/tasks`.
2. Server resolves actor identity from trusted headers or environment.
3. Planner creates action steps.
4. Policy evaluates each step.
5. Allowed read steps execute and persist source-call evidence.
6. Blocked steps stop the run.
7. Risky mutation steps create approvals and wait.
8. Approved steps are released by an authorized actor.
9. Every received, planned, held, blocked, approved, and executed action writes audit evidence.

## Security Model

- Server-side RBAC controls request creation, policy creation, workload evaluation, and approval release.
- The client never chooses approval authority.
- Sensitive keys and values are redacted before storage, API responses, UI display, and export.
- Source adapters run with scoped credentials: CNPG application role, read-only Kubernetes service account, server-side graph endpoint, read-only operations-feed parser, and append-only audit writer.
- Higher-risk deployments can add gVisor through Kubernetes `RuntimeClass`; isolation is additive to the action-gateway primitive.

## Validation

Local gates:

```sh
bun run --filter @proompteng/sag test
bun run --filter @proompteng/sag tsc
bun run --filter @proompteng/sag lint
bun run --filter @proompteng/sag lint:oxlint
bun run --filter @proompteng/sag build
```

Live gates:

```sh
curl -fsS https://sag.proompteng.ai/api/health
curl -fsS -X POST https://sag.proompteng.ai/api/tasks \
  -H 'content-type: application/json' \
  --data '{"text":"Inspect protected workloads, policy records, audit history, and operations feed"}'
curl -fsS -X POST https://sag.proompteng.ai/api/tasks \
  -H 'content-type: application/json' \
  --data '{"text":"Inspect protected workloads and execute a guarded restart after policy approval"}'
curl -fsS https://sag.proompteng.ai/api/events/export
```
