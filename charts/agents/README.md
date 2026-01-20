# Agents Helm Chart

Minimal, production‑ready bundle for the Agents control plane (Jangar) plus Agents CRDs.

## Features
- Ships v1alpha1 CRDs: Agent, AgentRun, AgentProvider, ImplementationSpec, ImplementationSource, Memory.
- Deploys the Jangar control-plane deployment + service.
- Minimal chart footprint (no ingress, no embedded database, no backups, no migrations job).
- Controller runs in‑cluster and reconciles AgentRun, ImplementationSpec, ImplementationSource, AgentProvider, Memory.
- Job runtime creates input/run spec ConfigMaps and labels Jobs for traceability.
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

The memory sample includes a placeholder Secret. Update the connection string before using it in production.

For workflow runtime execution, ensure the workload image includes `agent-runner` or set
`env.vars.JANGAR_AGENT_RUNNER_IMAGE` (or `env.vars.JANGAR_AGENT_IMAGE`) to a runner image.

Optional: submit runs with `agentctl`:
```bash
agentctl run submit --agent codex-agent --impl codex-impl-sample --runtime workflow --workload-image ghcr.io/proompteng/codex-agent:latest
```

Optional: configure GitHub/Linear ingestion with `ImplementationSource` manifests:
- `charts/agents/examples/implementationsource-github.yaml`
- `charts/agents/examples/implementationsource-linear.yaml`
Webhook signature verification uses the `auth.secretRef` secret; configure your webhook sender accordingly.

Local smoke test:
```bash
scripts/agents/smoke-agents.sh
```

## Database configuration
Jangar requires a database connection string. Supply one of:
- `database.url` (inline), or
- `database.secretRef` (existing Secret), or
- `database.createSecret.enabled=true` with `database.url`.

Agent memory backends are configured separately via the `Memory` CRD and its referenced Secret.
Use `env.vars.JANGAR_MIGRATIONS=skip` to disable automatic migrations if needed.

## Production notes
- Use a dedicated Postgres/managed DB and set `database.secretRef`.
- Pin Jangar image digests in `values-prod.yaml`.
- Keep `service.type=ClusterIP` and use ingress/mesh externally if desired.
- Set `rbac.clusterScoped=true` when `controller.namespaces` spans multiple namespaces or `"*"`.

## Crossplane removal
Crossplane-based Agents XRDs are not used. Remove Crossplane and XRDs before installing
the native chart. See `docs/agents/crossplane-migration.md`.

## Publishing (OCI)
```bash
helm package charts/agents
helm push agents-0.6.0.tgz oci://ghcr.io/proompteng/charts
```

## Values
| Key | Description | Default |
| --- | ----------- | ------- |
| `replicaCount` | Control-plane replicas | `1` |
| `image.repository` | Jangar image repo | `ghcr.io/proompteng/jangar` |
| `image.tag` | Jangar image tag | `latest` |
| `image.digest` | Optional image digest pin | `""` |
| `image.pullSecrets` | Image pull secret names | `[]` |
| `service.type` | Service type | `ClusterIP` |
| `service.port` | Service port | `80` |
| `service.annotations` | Service annotations | `{}` |
| `service.labels` | Extra Service labels | `{}` |
| `serviceAccount.create` | Create service account | `true` |
| `serviceAccount.name` | Service account name override | `""` |
| `rbac.create` | Create RBAC | `true` |
| `rbac.clusterScoped` | Use ClusterRole/ClusterRoleBinding for multi-namespace reconciliation | `false` |
| `database.url` | Database URL for Jangar | `""` |
| `database.secretRef.name` | Secret containing database URL | `""` |
| `database.caSecret.name` | Secret containing DB CA cert | `""` |
| `envFromSecretRefs` | Secret names to load as envFrom | `[]` |
| `envFromConfigMapRefs` | ConfigMap names to load as envFrom | `[]` |
| `controller.enabled` | Enable Agents controller loop | `true` |
| `controller.namespaces` | Namespaces to watch | `['<release-namespace>']` |
| `controller.intervalSeconds` | Controller reconcile interval | `15` |
| `controller.concurrency.perNamespace` | Max running AgentRuns per namespace | `10` |
| `controller.concurrency.perAgent` | Max running AgentRuns per Agent | `5` |
| `controller.concurrency.cluster` | Max running AgentRuns cluster-wide | `100` |
| `agentComms.enabled` | Enable NATS agent-comms subscriber | `false` |
| `agentComms.nats.url` | NATS URL | `""` |
| `livenessProbe.enabled` | Enable liveness probe | `true` |
| `readinessProbe.enabled` | Enable readiness probe | `true` |
| `logging.level` | Log level for Jangar | `info` |

See `values.yaml`, `values-local.yaml`, `values-dev.yaml`, and `values-prod.yaml` for full options.
