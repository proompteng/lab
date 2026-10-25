# Jangar primitives integration contract

Status: current source-backed contract. This document describes how Jangar consumes the generic Agents primitives; it
is not a plan for moving the Agents control plane into Jangar.

## 1) Ownership and implementation boundary

`services/agents` is the implementation owner for the generic primitives. Its route registrations live under
`services/agents/src/routes/v1/**`; its controllers, policy, persistence, and provider adapters live under
`services/agents/src/server/**`. The `charts/agents` CRDs and `argocd/applications/agents` desired state deploy that
implementation.

Jangar implements only its domain integration: request construction, domain authorization/gating, consumption of
Agents status/evidence, and Jangar-owned domain persistence. It must not add any of the following:

- generic Agents or Orchestration CRDs, controllers, watches, Jobs, ConfigMaps, PVCs, logs, or artifacts;
- a second `/v1/agents`, `/v1/agent-runs`, `/v1/memories`, or `/v1/orchestrations` API;
- a second idempotency, run-status, or generic audit ledger;
- a `MemoryProvider` controller or a fixed provider database/schema assumption.

The Agents controller is leader-gated for mutations. Jangar should call the service endpoint and surface a rejected or
unavailable Agents dependency as a domain dependency failure; it must not bypass the service with direct Kubernetes
writes.

## 2) Current API contract

The canonical route list is maintained in
`docs/jangar/primitives/control-plane.md` and is registered in
`services/agents/src/server/control-plane.ts`. The following request rules are the implementation contract:

### Resource submissions

These handlers require an `Idempotency-Key` HTTP header and a JSON body:

- `POST /v1/agents`: `{ "name": "...", "namespace": "...", "spec": { ... }, "policy": { ... } }`
- `POST /v1/memories`: `{ "name": "...", "namespace": "...", "spec": { ... } }`
- `POST /v1/orchestrations`: `{ "name": "...", "namespace": "...", "spec": { ... }, "policy": { ... } }`
- `POST /v1/agent-runs`: an AgentRun submission payload validated by
  `services/agents/src/server/v1/agent-runs-payload.ts`
- `POST /v1/orchestration-runs`: `{ "orchestrationRef": { "name": "..." }, "namespace": "...", "parameters": { ... }, "policy": { ... } }`

The `namespace` is a Kubernetes namespace, not a Jangar tenant or database schema. Send it explicitly for every
domain request. Agents defaults missing submission namespaces to `agents`; Jangar should still send its intended
namespace rather than relying on that default.

For AgentRun submissions, the header is the delivery identity. The optional body `idempotencyKey` is the
AgentRun-level reservation key and defaults to the header value. The Agents service stores delivery/run projections
and labels the applied resource; Jangar does not create another record before or after submission.

### Memory operations

`POST /v1/memory-operations` also requires `Idempotency-Key`. Its body contains `memoryRef` (either a name plus
`namespace` or a `namespace/name` reference) and one of:

- `operation: "event"` with `eventType` and optional object `payload`;
- `operation: "kv"` with `key` and object `value`;
- `operation: "embedding"` with `key`, `text`, and optional object `metadata`;
- `operation: "query"` with `query` and optional positive numeric `limit`;
- `operation: "embedding-index"` with no additional payload.

`query` is read-only; `event`, `kv`, `embedding`, and `embedding-index` are provider mutations and are leader-gated.
`POST /v1/memory-queries` is the read-only query route and still requires `Idempotency-Key` for the current API
contract.

### Read paths

Every namespace-scoped read carries `?namespace=<kubernetes-namespace>`:

- `GET /v1/agents/{name}`
- `GET /v1/memories/{name}`
- `GET /v1/orchestrations/{name}`
- `GET /v1/agent-runs/{record-id}`
- `GET /v1/orchestration-runs/{record-id}`
- `GET /v1/runs/{record-id}`

The run reads use the Agents database record ID. When the record has an external resource reference, Agents refreshes
the persisted status from the Kubernetes AgentRun or OrchestrationRun. `GET /v1/runs/{record-id}` returns `kind`,
the normalized run record, and the current resource when it can resolve one.

List/resource reads are:

- `GET /v1/agent-runs?agentId=<name>` or `?status=<phase>`; one filter is required;
- `GET /v1/orchestration-runs?orchestrationId=<name>` (or `orchestrationName`);
- `GET /v1/agent-runs/resources?namespace=<namespace>`;
- `GET /v1/memories/resources?namespace=<namespace>`;
- `GET /v1/orchestration-runs/resources?namespace=<namespace>`.

There is no `orchestration-executions` resource or endpoint. Use `OrchestrationRun` and
`/v1/orchestration-runs`.

## 3) Persistence and schema

No generic primitive DDL belongs in Jangar. Jangar's `jangar-db` is for Jangar/Torghut domain records, evidence,
readiness, and domain audit. Agents' `services/agents/src/server/migrations/**` own the Agents database schema:

| Agents-owned relation                    | Purpose                                                 |
| ---------------------------------------- | ------------------------------------------------------- |
| `public.agent_runs`                      | persisted AgentRun submission/status projection         |
| `public.agent_run_idempotency_keys`      | AgentRun idempotency reservations and terminal state    |
| `public.memory_resources`                | hydrated Memory CRD projection                          |
| `public.orchestration_runs`              | persisted OrchestrationRun submission/status projection |
| `public.audit_events`                    | Agents submission and policy audit events               |
| `memories.entries`                       | Agents memory notes used by `/v1/memory-notes`          |
| `agents_control_plane.resources_current` | optional denormalized Kubernetes resource cache         |

The current production Agents desired state uses namespace `agents`, CNPG cluster `agents-db-next`, and database
`agents` with application credentials in `agents-db-app`. The physical cluster name is a deployment detail; do not
hard-code it in Jangar code.

### Memory provider schema

The `Memory` CRD is `memories.agents.proompteng.ai/v1alpha1`. Its current contract is:

```
apiVersion: agents.proompteng.ai/v1alpha1
kind: Memory
metadata:
  name: agents-primitives
  namespace: agents
spec:
  type: postgres
  connection:
    secretRef:
      name: agents-db-app
      key: uri
  capabilities:
    - vector
```

`services/agents/src/server/memory-provider.ts` resolves that Secret in the Memory namespace. The current provider
uses the Memory metadata name as `dataset` and the `public` schema; it does not read `spec.dataset.schema` or a
`MemoryProvider` resource. `memory-provider-schema.ts` creates/uses:

- `public.memory_events(dataset, event_type, payload)`;
- `public.memory_kv(dataset, key, value)`;
- `public.memory_embeddings(dataset, key, embedding, metadata)`.

The provider requires `vector` and `pgcrypto`, and the `vector(dimension)` is selected from the Agents embedding
configuration. A Memory Secret may point at another PostgreSQL database, so a client or validation tool must inspect
the Memory resource and use that provider database; `facteur` is not a generic default.

The provider tables and `memories.entries` are different stores with different contracts. Jangar must not query either
store as if it were the other, and must not persist decoded provider credentials in Jangar-owned data.

## 4) Controllers, status, and policy

Agents owns all generic reconciliation:

- the AgentRun controller resolves Agent, provider, implementation, VCS, SecretBinding, policy, and workload inputs,
  creates the runner Job/ConfigMap contract, and reconciles logs, artifacts, cancellation, and terminal status;
- the orchestration controller reconciles Orchestration and OrchestrationRun, child AgentRun/ToolRun resources,
  retries, gates, signals, checkpoints, and `status.stepStatuses`;
- the supporting-primitives controller and primitives reconciler watch supporting resources and project
  AgentRun/OrchestrationRun/Memory state into the Agents database.

Jangar consumes `status.phase`, `status.conditions`, `status.stepStatuses`, the Agents readiness endpoints, and
`/v1/control-plane/status`. It must not patch status to manufacture a success, infer a provider execution from a
database row alone, or treat Jangar readiness as proof that an AgentRun succeeded.

Generic provider, service-account, secret, approval, budget, workload, and namespace admission is enforced by Agents.
Jangar may make an additional domain decision before submission, but the request still goes through Agents policy and
leader checks. Policy allow/deny evidence is emitted by Agents' audit path.

## 5) Acceptance criteria for Jangar integration

A Jangar integration is complete when all of the following hold:

1. It calls the Agents service routes above with an explicit namespace and the required idempotency header.
2. It does not add generic CRDs, controllers, persistence tables, or direct Kubernetes mutation.
3. It treats Agents status/resource state as the generic authority and keeps Jangar domain evidence separate.
4. It distinguishes an accepted submission, a running resource, a succeeded resource, and a failed/unavailable Agents
   dependency.
5. Its tests cover route construction, namespace propagation, idempotency behavior, error mapping, and the
   domain-specific gate without requiring a production cluster.
6. Production proof uses the read-only validator in
   `scripts/jangar/validate-primitives.sh` plus an explicitly authorized canary for any new write path; the
   validator itself never creates, patches, deletes, or mutates a resource.
