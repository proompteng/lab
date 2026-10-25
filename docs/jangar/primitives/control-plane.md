# Jangar control-plane boundary

## Ownership

The generic Agents control plane has one owner: `services/agents`, delivered by the `charts/agents` Helm release and
the `argocd/applications/agents` GitOps application. Agents owns the `agents.proompteng.ai/v1alpha1` and
`orchestration.proompteng.ai/v1alpha1` CRDs, their REST handlers, persistence, leader-gated mutations, controllers,
watchers, runner workloads, status, logs, and artifacts.

Jangar is a domain client and event consumer. Its route tree and server modules under `services/jangar/src/routes/**`
and `services/jangar/src/server/**` own Jangar/Torghut domain behavior, readiness, evidence, and domain storage. Jangar
does not create or reconcile generic Agents resources, expose a second generic resource API, or maintain a second
resource browser. A Jangar feature that needs a generic primitive calls the Agents service boundary.

The source of truth for this split is:

- Agents route registration and runtime wiring: `services/agents/src/server/control-plane.ts`
- Agents HTTP routes: `services/agents/src/routes/v1/**`
- Agents controllers: `services/agents/src/server/agents-controller/**`,
  `services/agents/src/server/orchestration-controller.ts`, `services/agents/src/server/supporting-primitives-controller.ts`,
  and `services/agents/src/server/primitives-reconciler.ts`
- Jangar consumer integration: `services/jangar/src/routes/health.tsx`, `services/jangar/src/routes/ready.tsx`, and
  `services/jangar/src/server/control-plane-status.ts`

## Agents service API

These are the current generic routes served by `services/agents`. Namespace-scoped reads accept an explicit
`namespace` query parameter and default to `agents` when it is omitted; they never infer `jangar`. Operators and
cross-service callers should still pass the namespace explicitly so the target is visible and portable.

| Capability              | Route                                                        | Contract                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent resource          | `POST /v1/agents`                                            | Applies an `Agent` resource; requires `Idempotency-Key`.                                                                                           |
| Agent resource          | `GET /v1/agents/{id}?namespace={namespace}`                  | Reads an `Agent` resource.                                                                                                                         |
| Agent run               | `POST /v1/agent-runs`                                        | Submits an `AgentRun`; requires `Idempotency-Key`.                                                                                                 |
| Agent run               | `GET /v1/agent-runs/{id}?namespace={namespace}`              | Reads the Agents DB record and refreshes it from the `AgentRun` resource when available.                                                           |
| Agent run               | `GET /v1/agent-runs?agentId={name}` or `?status={phase}`     | Lists persisted AgentRun records; one filter is required.                                                                                          |
| Agent run resources     | `GET /v1/agent-runs/resources?namespace={namespace}`         | Read-only typed-resource list.                                                                                                                     |
| Memory resource         | `POST /v1/memories`                                          | Applies a `Memory` resource and hydrates the Agents DB projection; requires `Idempotency-Key`.                                                     |
| Memory resource         | `GET /v1/memories/{id}?namespace={namespace}`                | Reads a `Memory` resource and hydrates its projection.                                                                                             |
| Memory resources        | `GET /v1/memories/resources?namespace={namespace}`           | Read-only typed-resource list.                                                                                                                     |
| Memory operation        | `POST /v1/memory-operations`                                 | Requires `Idempotency-Key`; supports `event`, `kv`, `embedding`, `query`, and `embedding-index`. Only non-`query` operations mutate provider data. |
| Memory query            | `POST /v1/memory-queries`                                    | Requires `Idempotency-Key`; resolves a `Memory` provider and returns vector results.                                                               |
| Orchestration           | `POST /v1/orchestrations`                                    | Applies an `Orchestration` resource; requires `Idempotency-Key`.                                                                                   |
| Orchestration           | `GET /v1/orchestrations/{id}?namespace={namespace}`          | Reads an `Orchestration` resource.                                                                                                                 |
| Orchestration run       | `POST /v1/orchestration-runs`                                | Creates an `OrchestrationRun`; requires `Idempotency-Key`.                                                                                         |
| Orchestration run       | `GET /v1/orchestration-runs/{id}?namespace={namespace}`      | Reads the persisted run and refreshes status from its resource.                                                                                    |
| Orchestration run       | `GET /v1/orchestration-runs?orchestrationId={name}`          | Lists persisted runs for an orchestration.                                                                                                         |
| Orchestration resources | `GET /v1/orchestration-runs/resources?namespace={namespace}` | Read-only typed-resource list.                                                                                                                     |
| Unified run read        | `GET /v1/runs/{id}?namespace={namespace}`                    | Read-only lookup that returns `kind`, the AgentRun or OrchestrationRun record, and the current resource when available.                            |
| Control-plane evidence  | `GET /v1/control-plane/status?namespace={namespace}`         | Agents controller and ingestion status; use this from Jangar readiness/evidence consumers.                                                         |

There is no `/v1/orchestration-executions` route. The resource and API name is `OrchestrationRun`, and the canonical
route is `/v1/orchestration-runs`.

All POST handlers require the `Idempotency-Key` header. For Agent, Orchestration, Memory, AgentRun, and
OrchestrationRun submissions, Agents uses that value as the delivery identity and labels the applied resource. An
AgentRun may also carry a body `idempotencyKey`; that is the run-level idempotency key and defaults to the header value.
Jangar must not invent a second delivery ledger for these generic operations.

## Status and policy

Agents controllers watch and reconcile the generic resources and their provider workloads. In particular,
`services/agents/src/server/orchestration-controller.ts` reconciles `Orchestration` and `OrchestrationRun`, creates
child `AgentRun`/`ToolRun` resources, and records `status.phase`, `status.conditions`, and `status.stepStatuses`.
`services/agents/src/server/primitives-reconciler.ts` projects AgentRun, OrchestrationRun, and Memory state into the
Agents database. Jangar consumes those status/evidence surfaces; it does not write status fields or watch Kubernetes
resources directly as a second controller.

Admission policy is also Agents-owned. AgentRun and Orchestration submissions validate provider/source, service-account,
secret, approval, budget, workload, and namespace constraints through `services/agents/src/server/primitives-policy.ts`
and the submission handlers. Jangar may add domain-specific gates before requesting a submission, but it must not
duplicate or weaken generic admission.

## Persistence boundary

Jangar's `jangar-db` stores Jangar/Torghut domain records, evidence, and readiness state. The generic Agents database is
the source of truth for Agents control-plane persistence and projections. In the current Agents migrations this
includes:

- `public.agent_runs`
- `public.agent_run_idempotency_keys`
- `public.memory_resources`
- `public.orchestration_runs`
- `public.audit_events`
- `memories.entries` for Agents memory notes
- `agents_control_plane.resources_current` for the optional denormalized resource cache

The `memory_resources` table is an Agents-owned projection of a `Memory` CRD. It is not the provider's vector
database and does not make Jangar the owner of the Memory resource.

## Memory provider boundary

`Memory` is an Agents CRD (resource `memories.agents.proompteng.ai`) with `spec.type` and
`spec.connection.secretRef`. `services/agents/src/server/memory-provider.ts` resolves the referenced Secret in the
Memory's namespace, uses the Memory metadata name as the dataset, and currently uses the `public` schema. It does not
resolve a `MemoryProvider` CRD or a `spec.dataset.schema` field.

The PostgreSQL provider creates/uses these tables in the selected provider database:

- `<schema>.memory_events`
- `<schema>.memory_kv`
- `<schema>.memory_embeddings`

The schema is generated by `services/agents/src/server/memory-provider-schema.ts`; `vector` and `pgcrypto` extensions
are required, and the embedding dimension comes from the Agents embedding configuration. In production's current
`agents-primitives` resource, the Secret is `agents/agents-db-app` and the provider database is therefore the Agents
database. A different Memory Secret may point to another database; validation must inspect that resource and override
its database target rather than assuming `facteur`.

Jangar memory notes (the `/v1/memory-notes` route) are a separate Agents-owned store in `memories.entries`. Do not confuse that
note store with the provider tables used by `/v1/memory-operations` and `/v1/memory-queries`.
