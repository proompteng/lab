# Agents Helm Chart

Minimal, production‑ready bundle for the Agents control plane (Jangar) plus Agents CRDs.

## Features
- Ships v1alpha1 CRDs: Agent, AgentRun, AgentProvider, ImplementationSpec, ImplementationSource, Memory.
- Deploys the Jangar control-plane deployment + service.
- Minimal chart footprint (no ingress, no embedded database, no backups, no migrations job).
- Controller runs in‑cluster and reconciles AgentRun, ImplementationSpec, ImplementationSource, AgentProvider, Memory.
- Artifact Hub metadata included (Apache‑2.0 license).

## Quickstart (kind/minikube)
```bash
# From repo root
helm lint charts/agents
helm template charts/agents --values charts/agents/values-local.yaml
helm install agents charts/agents --namespace agents --create-namespace \
  --values charts/agents/values-local.yaml
kubectl -n agents port-forward svc/agents 8080:80 &
curl -sf http://127.0.0.1:8080/health
```

Apply the sample CRDs:
```bash
kubectl apply -n agents -f charts/agents/examples/agentprovider-sample.yaml
kubectl apply -n agents -f charts/agents/examples/agent-sample.yaml
kubectl apply -n agents -f charts/agents/examples/memory-sample.yaml
kubectl apply -n agents -f charts/agents/examples/implementationspec-sample.yaml
kubectl apply -n agents -f charts/agents/examples/agentrun-sample.yaml
```

Optional: submit runs with `agentctl`:
```bash
agentctl run submit --agent codex-agent --impl codex-impl-sample --runtime job --workload-image ghcr.io/proompteng/codex-agent:latest
```

Optional: configure GitHub/Linear ingestion with `ImplementationSource` manifests (see `charts/agents/examples/implementationsource-github.yaml`).

## Database configuration
Jangar requires a database connection string. Supply one of:
- `database.url` (inline), or
- `database.secretRef` (existing Secret), or
- `database.createSecret.enabled=true` with `database.url`.

Agent memory backends are configured separately via the `Memory` CRD and its referenced Secret.

## Production notes
- Use a dedicated Postgres/managed DB and set `database.secretRef`.
- Pin Jangar image digests in `values-prod.yaml`.
- Keep `service.type=ClusterIP` and use ingress/mesh externally if desired.

## Publishing (OCI)
```bash
helm package charts/agents
helm push agents-0.2.0.tgz oci://ghcr.io/proompteng/charts
```

## Values
| Key | Description | Default |
| --- | ----------- | ------- |
| `replicaCount` | Control-plane replicas | `1` |
| `image.repository` | Jangar image repo | `ghcr.io/proompteng/jangar` |
| `image.tag` | Jangar image tag | `latest` |
| `database.url` | Database URL for Jangar | `""` |
| `database.secretRef.name` | Secret containing database URL | `""` |
| `controller.enabled` | Enable Agents controller loop | `true` |
| `controller.namespaces` | Namespaces to watch | `['<release-namespace>']` |
| `controller.intervalSeconds` | Controller poll interval | `15` |
| `rbac.create` | Create namespaced RBAC (Role/RoleBinding) | `true` |
| `agentComms.enabled` | Enable NATS agent-comms subscriber | `false` |

See `values.yaml`, `values-local.yaml`, `values-dev.yaml`, and `values-prod.yaml` for full options.
