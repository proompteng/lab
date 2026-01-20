# Memory Primitive

## Purpose

The `Memory` primitive provides a provider-agnostic contract for durable, queryable, and retrievable memory
associated with agents and workflows. It supports vector embeddings, retention policies, and access control
without coupling to a specific backend implementation.

Jangar is the control plane for all `Memory` resources.

## Grounding in the current platform

- Existing CNPG clusters (live): `facteur/facteur-vector-cluster`, `jangar/jangar-db`
- Current agent event storage direction: `docs/nats-agent-communications.md`

## CRDs

### Memory (claim)
Namespace-scoped, app-facing memory dataset.

```yaml
apiVersion: memory.proompteng.ai/v1alpha1
kind: Memory
metadata:
  name: codex-agent-memory
  namespace: jangar
spec:
  providerRef:
    name: postgres-default
  dataset:
    name: codex_agent
    schema: agent_memory
  retention:
    ttlDays: 90
  embeddings:
    enabled: true
    dimension: 1536
  access:
    readerRole: memory_reader
    writerRole: memory_writer
```

### MemoryStore (internal)
Composite resource that binds the logical memory dataset to a concrete provider.

## Provider decoupling rules

- `Memory.spec` includes only intent and schema-level requirements.
- Provider details live under `spec.provider.<type>` or are supplied by a referenced provider resource.
- Switching providers is achieved by updating the `providerRef` or composition selector, without changing
  application-level contracts.

## Postgres provider (first implementation)

### Requirements

- Backed by CloudNativePG (CNPG) clusters
- `pgvector` extension enabled for embeddings
- Stable connection secret with role-based access

### Provider configuration

```yaml
apiVersion: memory.proompteng.ai/v1alpha1
kind: MemoryProvider
metadata:
  name: postgres-default
  namespace: jangar
spec:
  type: postgres
  postgres:
    clusterRef:
      name: facteur-vector-cluster
      namespace: facteur
    database: memory_codex_agent
    schema: agent_memory
    enablePgVector: true
```

### Connection contract

`Memory.status.connectionSecretRef` must include the `name` and `namespace` of the connection secret.
Additional connection metadata is exposed on `Memory.status`:

- `endpoint`
- `database`
- `schema`

The referenced secret must contain:

- `username`
- `password`

## Schema baseline

- `memory_events` (append-only)
- `memory_embeddings` (vector + metadata)
- `memory_kv` (simple key/value)

## Retention

Retention is enforced by provider-specific jobs (SQL or background worker). The retention contract
is stored on the Memory resource; the backend implementation must honor it.

## Access model

- Readers are granted `SELECT` and `EXECUTE` on schema functions
- Writers are granted `INSERT/UPDATE` on tables, plus vector upsert

## Observability

Jangar should emit memory lifecycle events and link them to agent/orchestration runs via run IDs.

## Schema precedence

`Memory.spec.dataset.schema` is the source of truth. `MemoryProvider.spec.postgres.schema` may
provide a default; if both are set and differ, reconciliation should fail.
