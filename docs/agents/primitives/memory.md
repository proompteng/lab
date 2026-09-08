# Memory Primitive

## Purpose and ownership

`Memory` is the namespace-scoped Agents resource that selects a memory backend, its connection Secret, and the
capabilities that a consumer expects. The installed `v1alpha1` contract is intentionally small: it does not declare a
dataset name, schema, retention policy, embedding dimension, or reader/writer roles.

The Agents service owns the `Memory` CRD, reconciliation, and memory operation APIs. Jangar can integrate with those
service APIs, but the generic resource and its lifecycle are not Jangar-owned. These routes are served by the Agents
service; they should not be inferred to be Jangar routes.

## Current source of truth

- Go API types: `services/agents/api/agents/v1alpha1/types.go` (`MemorySpec`, `MemoryConnection`, `MemoryStatus`)
- Generated CRD: `charts/agents/crds/agents.proompteng.ai_memories.yaml`
- Chart example: `charts/agents/examples/memory-sample.yaml`
- Reconciler: `services/agents/src/server/agents-controller/resource-reconcilers.ts` (`reconcileMemory`)
- Runtime provider: `services/agents/src/server/memory-provider.ts`
- Runtime schema: `services/agents/src/server/memory-provider-schema.ts`

## `Memory` resource

`Memory` is namespaced. `spec.connection.secretRef.name` refers to a Secret in the same namespace because the CRD
reference contains a name and optional key, not a namespace.

This is a valid resource shape. The Secret is included to show the connection contract; use a real Secret managed by
the deployment rather than committing credentials.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: default-memory-postgres
  namespace: agents
type: Opaque
stringData:
  url: postgresql://memory:replace-me@postgres.default.svc.cluster.local:5432/memory?sslmode=disable
---
apiVersion: agents.proompteng.ai/v1alpha1
kind: Memory
metadata:
  name: default-memory
  namespace: agents
spec:
  type: postgres
  connection:
    secretRef:
      name: default-memory-postgres
      key: url
  capabilities:
    - vector
    - kv
  default: true
```

### Spec fields

| Field                       | Current contract                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spec.type`                 | Required string. The generated CRD enum is `postgres`, `redis`, `weaviate`, `pinecone`, or `custom`.                                                                                                         |
| `spec.connection.secretRef` | Required object. `name` is required; `key` is optional.                                                                                                                                                      |
| `spec.capabilities`         | Optional string list. The Go type documents `vector`, `kv`, and `blob` as intended values, but the generated CRD currently emits only `type: string` for each item, so admission does not enforce that list. |
| `spec.default`              | Optional boolean with a generated default of `false`. `true` marks the resource as a default; it does not configure storage or schema.                                                                       |

There are no other `Memory.spec` fields in the installed CRD. In particular, `providerRef`, `dataset`, `retention`,
`embeddings`, `access`, and provider-specific nested configuration are not valid current fields.

### Status fields

The status schema contains only optional `lastCheckedAt`, `conditions`, `updatedAt`, and `observedGeneration` fields.
The Agents controller checks the type and same-namespace Secret reference, then records conditions such as:

- `Ready=True, reason=SecretResolved` when the Secret exists and an optional key is present;
- `InvalidSpec` for a missing type, missing Secret reference, or missing referenced key;
- `Unreachable, reason=SecretNotFound` when the Secret does not exist.

`Ready` means that the resource's reference was checked. It is not a database connectivity or pgvector health check.
There is no `status.phase`, `status.connectionSecretRef`, `status.endpoint`, `status.database`, or `status.schema` in
the current API.

## Current Postgres runtime behavior

The runtime implementation currently accepts only `spec.type: postgres`. The other values are admitted by the CRD but
memory operations fail closed with an unsupported-type error until a corresponding provider implementation exists.

For a Postgres Memory operation, the Agents runtime:

1. Loads the `Memory` resource and resolves its Secret in the Memory namespace.
2. Decodes Secret `data`; if `secretRef.key` is set, that key is preferred. Otherwise it accepts `url`, `uri`, or
   `connectionString`, or constructs a URL from `endpoint`/`host`, `database`/`dbname`, `username`/`user`, and
   `password`.
3. Uses the Memory metadata name as the internal dataset discriminator and uses the fixed `public` schema. Neither
   value is configurable in the current CRD.
4. Ensures the `vector` and `pgcrypto` extensions and creates/uses `memory_events`, `memory_kv`, and
   `memory_embeddings` tables. Each table is scoped logically by the `dataset` column; it is not a separate schema
   per Memory resource.
5. Resolves the embedding dimension from Agents runtime configuration, not from `Memory.spec`.

The operation API currently supports `event`, `kv`, `embedding`, `query`, and `embedding-index`. The separate query
route performs vector search. Capabilities are declarative metadata; the operation handlers do not expose a `blob`
operation.

## Agents API boundary

The current Agents service routes are:

- `POST /v1/memories` — accepts a JSON payload containing `name`, `namespace`, and `spec`, then applies a Memory CR.
- `GET /v1/memories/$id` — reads a Memory resource through the generic resource reader.
- `POST /v1/memory-operations` — handles event, key/value, embedding, query, and embedding-index operations.
- `POST /v1/memory-queries` — performs a vector query from `memoryRef`, `namespace`, `query`, and optional `limit`.

The mutation/query handlers require the `Idempotency-Key` HTTP header. This HTTP idempotency key is not a
`Memory.spec` field.

## Future design boundary (not an installed API)

The following names and fields came from an earlier proposal and must not be applied to the current cluster:

- `apiVersion: memory.proompteng.ai/v1alpha1`;
- `MemoryProvider` and `MemoryStore` resources;
- `Memory.spec.providerRef`, `dataset`, `retention`, `embeddings`, and `access`;
- `MemoryProvider.spec.postgres.*` and composition/provider selectors;
- `Memory.status.connectionSecretRef`, `endpoint`, `database`, and `schema`;
- schema-precedence or provider-specific retention/access guarantees.

They may be discussed only as future design work. There is an internal TypeScript module named
`memory-provider.ts`, but it is not a `MemoryProvider` CRD and does not make those proposal fields valid.
