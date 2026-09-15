# Jangar/Agents primitives production validation

Status: current read-only validation runbook. The generic primitive control plane is operated by `services/agents`;
Jangar is validated as a consumer of that service and as the owner of its own domain evidence. A green check here does
not prove a new submission, worker execution, or business outcome.

## Authority and production defaults

Use the current source and desired state as the authority for every run:

- Agents routes and controllers: `services/agents/src/server/control-plane.ts` and `services/agents/src/server/**`.
- Jangar's dependency/readiness integration: `services/jangar/src/server/control-plane-status.ts` and
  `services/jangar/src/routes/health.tsx`/`ready.tsx`.
- Production namespace: `agents`.
- Agents CNPG cluster/database: `agents-db-next` / `agents` in namespace `agents`; the application Secret is
  `agents-db-app`.
- Current `Memory` resource: `agents/agents-primitives`, with `spec.type: postgres` and
  `spec.connection.secretRef: { name: agents-db-app, key: uri }`.

The `Memory` resource is the provider authority. Agents resolves its Secret in the resource namespace, uses the Memory
metadata name (`agents-primitives`) as the dataset, and currently uses the `public` schema. The provider relations are
`public.memory_events`, `public.memory_kv`, and `public.memory_embeddings`; `vector` and `pgcrypto` are required.
`memories.entries` is the separate Agents memory-notes store. Jangar's `jangar-db` is a domain database and is not a
generic primitive database. Do not assume a `facteur` cluster or a `jangar_primitives` schema. If a Memory Secret points
at another PostgreSQL target, set all `MEMORY_DB_*` values to that target after inspecting the resource, and set
`MEMORY_SCHEMA`/`MEMORY_DATASET` to the provider's current values.

## Prerequisites

The operator needs:

- a `kubectl` context with read access to the `agents` namespace and the namespace containing the selected provider DB;
- the CloudNativePG `kubectl cnpg` plugin;
- `python3` (or `python`) for JSON and result validation;
- `curl` only when `AGENTS_BASE_URL` is set for optional HTTP probes.

Verify the target explicitly before running the script:

```sh
kubectl --namespace agents get memory.agents.proompteng.ai agents-primitives -o yaml
kubectl --namespace agents get orchestrationruns.orchestration.proompteng.ai -o name
kubectl cnpg status --namespace agents agents-db-next
```

Do not print or decode `agents-db-app`; the validator reports only its Secret name/key and the Memory Ready condition.

## Read-only validator

From the repository root:

```sh
scripts/jangar/validate-primitives.sh
```

The default run checks, using explicit namespaces:

1. the `Memory` CRD shape and its SecretRef without exposing credentials;
2. Agents-owned relations (`agent_runs`, AgentRun idempotency, `memory_resources`, `orchestration_runs`, audit events,
   `memories.entries`, and `agents_control_plane.resources_current`);
3. `vector` and `pgcrypto` in the Agents database;
4. provider relations and extensions in the selected Memory database;
5. row counts for the selected Memory dataset; and
6. existing `OrchestrationRun` status and populated `stepStatuses`.

For a release gate that requires persisted provider rows and a completed orchestration fixture, use:

```sh
scripts/jangar/validate-primitives.sh --require-memory-data --require-succeeded-run
```

The strict flags turn an absent provider row or absent succeeded run into a failure. Without them, the script still
prints the counts/status and treats an empty environment as a diagnostic result. Override only the exact target being
validated, for example:

```sh
AGENTS_NAMESPACE=agents \
AGENTS_DB_NAMESPACE=agents \
AGENTS_DB_CLUSTER=agents-db-next \
AGENTS_DB_NAME=agents \
MEMORY_NAMESPACE=agents \
MEMORY_NAME=agents-primitives \
MEMORY_DB_NAMESPACE=agents \
MEMORY_DB_CLUSTER=agents-db-next \
MEMORY_DB_NAME=agents \
MEMORY_SCHEMA=public \
MEMORY_DATASET=agents-primitives \
ORCHESTRATION_NAMESPACE=agents \
scripts/jangar/validate-primitives.sh
```

The script is fail-closed for malformed namespaces, database identifiers, schema identifiers, booleans, timeouts, and
HTTP schemes. Database dataset values are passed through a psql variable rather than interpolated into SQL. All
`kubectl` calls use `--namespace`; all database calls are `kubectl --namespace ... cnpg psql ...` with an explicit
database. The script performs no POST, apply, create, patch, delete, status write, port-forward, or secret read.

## Optional Agents HTTP evidence

Set `AGENTS_BASE_URL` only when the Agents service is already reachable through an approved read-only path. The script
then issues GET requests to `/health`, `/ready`, `/v1/control-plane/status`, and the typed AgentRun, Memory, and
OrchestrationRun resource lists. It does not submit an Agent, AgentRun, Memory, Memory operation, Orchestration, or
OrchestrationRun.

For a local diagnostic port-forward, run it in a separate terminal and scope it explicitly:

```sh
kubectl --namespace agents port-forward service/agents 8080:80
AGENTS_BASE_URL=http://127.0.0.1:8080 scripts/jangar/validate-primitives.sh
```

The current submission routes are `POST /v1/agents`, `/v1/agent-runs`, `/v1/memories`, `/v1/memory-operations`,
`/v1/memory-queries`, `/v1/orchestrations`, and `/v1/orchestration-runs`. Every one requires an `Idempotency-Key`.
Do not turn the read-only production check into a write smoke test. Any canary write requires an explicitly authorized,
isolated fixture and must be evaluated through the Agents-owned resource/status/audit path.

## Orchestration and memory interpretation

Use `OrchestrationRun.status.phase`, `status.conditions`, and `status.stepStatuses` from the existing resource as
evidence. Do not patch status, manufacture a succeeded run, or treat an Agents database row alone as proof that a
runner executed. The validator only reports a succeeded run when its resource has a `Succeeded` phase and at least one
step status.

Interpret the checks in layers:

- a `Memory` object and Ready condition mean configuration is present, not that a write was accepted;
- provider relation existence means the provider schema is installed, not that the current dataset has valid content;
- non-zero event/KV/embedding counts mean rows exist for the selected dataset, not that a query returned correct results;
- a persisted AgentRun/OrchestrationRun means the control plane recorded a request, not that a workload succeeded;
- a succeeded OrchestrationRun with step statuses is runtime evidence for that fixture, not proof of Jangar domain behavior.

Jangar must consume these Agents-owned surfaces and keep its domain evidence separate. It must not introduce generic CRDs,
controllers, status writers, provider-schema assumptions, or a second generic persistence ledger.
