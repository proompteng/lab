# Memory Primitive (Implementation-Grade Spec)

This document defines the full CRD schema and Postgres-backed implementation for the Memory primitive,
while preserving provider portability.

## 1) CRDs

### 1.1 XMemory (composite)

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xmemories.memory.proompteng.ai
spec:
  group: memory.proompteng.ai
  names:
    kind: XMemory
    plural: xmemories
  claimNames:
    kind: Memory
    plural: memories
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          required:
            - spec
          properties:
            spec:
              type: object
              required:
                - providerRef
                - dataset
              properties:
                providerRef:
                  type: object
                  required: [name]
                  properties:
                    name: { type: string }
                dataset:
                  type: object
                  required: [name, schema]
                  properties:
                    name: { type: string }
                    schema: { type: string }
                retention:
                  type: object
                  properties:
                    ttlDays: { type: integer, default: 90 }
                embeddings:
                  type: object
                  properties:
                    enabled: { type: boolean, default: true }
                    dimension: { type: integer, default: 1536 }
                access:
                  type: object
                  properties:
                    readerRole: { type: string }
                    writerRole: { type: string }
            status:
              type: object
              properties:
                providerType: { type: string }
                endpoint: { type: string }
                database: { type: string }
                schema: { type: string }
                connectionSecretRef:
                  type: object
                  properties:
                    name: { type: string }
                    namespace: { type: string }
```

### 1.2 MemoryProvider

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xmemoryproviders.memory.proompteng.ai
spec:
  group: memory.proompteng.ai
  names:
    kind: XMemoryProvider
    plural: xmemoryproviders
  claimNames:
    kind: MemoryProvider
    plural: memoryproviders
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            spec:
              type: object
              required: [type]
              properties:
                type:
                  type: string
                  enum: [postgres, redis, s3, custom]
                postgres:
                  type: object
                  properties:
                    clusterRef:
                      type: object
                      required: [name, namespace]
                      properties:
                        name: { type: string }
                        namespace: { type: string }
                    database: { type: string }
                    schema: { type: string }
                    enablePgVector: { type: boolean, default: true }
                    connectionSecret:
                      type: object
                      properties:
                        name: { type: string }
                        namespace: { type: string }
```

## 2) Postgres provider implementation (first provider)

### 2.1 CNPG baseline

The live cluster already includes CNPG clusters suitable for memory storage:

- `facteur/facteur-vector-cluster`
- `jangar/jangar-db`

### 2.2 SQL schema (baseline)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset text NOT NULL,
  key text NOT NULL,
  embedding vector(1536),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_embeddings_dataset_key_idx ON memory_embeddings(dataset, key);
CREATE INDEX IF NOT EXISTS memory_embeddings_vector_idx ON memory_embeddings USING ivfflat (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS memory_kv (
  dataset text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset, key)
);
```

### 2.3 Provisioning flow (provider-kubernetes + SQL init job)

1) `MemoryProvider` references a CNPG cluster.
2) Composition creates a Kubernetes Job in the target namespace to run SQL migrations.
3) Connection secret is written to `Memory.status.connectionSecretRef`.

### 2.4 Connection secret

Required keys:

- `endpoint`
- `database`
- `schema`
- `username`
- `password`

## 3) Crossplane Composition (Postgres)

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: memory-postgres
  labels:
    provider: postgres
spec:
  compositeTypeRef:
    apiVersion: memory.proompteng.ai/v1alpha1
    kind: XMemory
  resources:
    - name: init-sql-job
      base:
        apiVersion: batch/v1
        kind: Job
        metadata:
          namespace: facteur
        spec:
          template:
            spec:
              restartPolicy: OnFailure
              containers:
                - name: init
                  image: postgres:16
                  command: ["/bin/bash", "-lc"]
                  args:
                    - |
                      psql "$POSTGRES_DSN" -f /migrations/memory.sql
      patches:
        - fromFieldPath: spec.dataset.schema
          toFieldPath: spec.template.spec.containers[0].env[?(@.name=="PGSCHEMA")].value
```

Implementation note: use Composition Function for dynamic SQL injection and secrets binding.

## 4) Provider decoupling

- Only `MemoryProvider` specifies backend details.
- Memory consumers never see provider-specific fields.
- Switching providers requires only updating `Memory.spec.providerRef` or composition selector.
