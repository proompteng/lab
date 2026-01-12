# Agents Helm Chart

Minimal, production-ready bundle for the agent control plane (Jangar) plus Agent/AgentRun/AgentProvider CRDs and an optional embedded Postgres/pgvector.

## Features
- Ships Agent, AgentRun, and AgentProvider CRDs.
- Deploys the Jangar control-plane deployment + service.
- Default single-replica Postgres with pgvector and idempotent migrations job.
- Optional ingress, HPA, PDB, NetworkPolicy, and pg_dump backup CronJob.
- Dev and production example values.
- Artifact Hub metadata included (Apache-2.0 license).

## Quickstart (kind/minikube)
```bash
# From repo root
helm lint charts/agents
helm template charts/agents --values charts/agents/values-dev.yaml
helm install agents charts/agents --namespace agents --create-namespace \
  --values charts/agents/values-dev.yaml
kubectl -n agents port-forward svc/agents 8080:80 &
curl -sf http://127.0.0.1:8080/health
```

Apply the sample CRDs:
```bash
kubectl apply -n agents -f charts/agents/examples/agentprovider-sample.yaml
kubectl apply -n agents -f charts/agents/examples/agent-sample.yaml
kubectl apply -n agents -f charts/agents/examples/agentrun-sample.yaml
```

## Production notes
- Prefer external Postgres with TLS: see `charts/agents/values-prod.yaml`.
- Use digest-pinned images for both Jangar and Postgres (already set in `values-prod`).
- Enable NetworkPolicy and PodDisruptionBudget for HA clusters.
- Migrations job creates `pgcrypto` + `vector` extensions and tables idempotently.
- Optional backup CronJob runs `pg_dump --format=custom` into a PVC with retention trimming.

## Publishing (OCI)
```bash
helm package charts/agents
helm push agents-0.1.0.tgz oci://ghcr.io/proompteng/charts
```

## Values
| Key | Description | Default |
| --- | ----------- | ------- |
| `replicaCount` | Control-plane replicas | `1` |
| `image.repository` | Jangar image repo | `ghcr.io/proompteng/jangar` |
| `image.tag` | Jangar image tag | `latest` |
| `postgres.enabled` | Deploy embedded Postgres/pgvector | `true` |
| `externalDatabase.enabled` | Use external Postgres instead of embedded | `false` |
| `migrations.enabled` | Run pre-install/upgrade migrations job | `true` |
| `ingress.enabled` | Create Ingress | `false` |
| `autoscaling.enabled` | Enable HPA | `false` |
| `podDisruptionBudget.enabled` | Enable PDB | `false` |
| `networkPolicy.enabled` | Enable NetworkPolicy | `false` |
| `backups.enabled` | Enable pg_dump CronJob (embedded DB only) | `false` |

See `values.yaml`, `values-dev.yaml`, and `values-prod.yaml` for full options.
