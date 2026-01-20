# Agents Helm Chart

Minimal, production‑ready bundle for the Agents control plane (Jangar) plus Agents CRDs.

## Features
- Ships v1alpha1 CRDs: Agent, AgentRun, AgentProvider, ImplementationSpec, ImplementationSource, Memory,
  Orchestration, OrchestrationRun, ApprovalPolicy, Budget, SecretBinding, Signal, SignalDelivery, Tool, ToolRun,
  Schedule, Artifact, Workspace.
- Deploys the Jangar control-plane deployment + service.
- Minimal chart footprint (no ingress, no embedded database, no backups, no migrations job).
- Controllers run in‑cluster and reconcile Agents, Orchestration, and supporting primitives (schedules, tools, workspaces).
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
kubectl apply -n agents -f charts/agents/examples/tool-sample.yaml
kubectl apply -n agents -f charts/agents/examples/orchestration-sample.yaml
kubectl apply -n agents -f charts/agents/examples/orchestrationrun-sample.yaml
```

Optional supporting primitives:
```bash
kubectl apply -n agents -f charts/agents/examples/approvalpolicy-sample.yaml
kubectl apply -n agents -f charts/agents/examples/budget-sample.yaml
kubectl apply -n agents -f charts/agents/examples/secretbinding-sample.yaml
kubectl apply -n agents -f charts/agents/examples/signal-sample.yaml
kubectl apply -n agents -f charts/agents/examples/signaldelivery-sample.yaml
kubectl apply -n agents -f charts/agents/examples/toolrun-sample.yaml
kubectl apply -n agents -f charts/agents/examples/schedule-sample.yaml
kubectl apply -n agents -f charts/agents/examples/artifact-sample.yaml
kubectl apply -n agents -f charts/agents/examples/workspace-sample.yaml
```

The memory sample includes a placeholder Secret. Update the connection string before using it in production.

For workflow runtime execution, ensure the workload image includes `agent-runner` or set
`env.vars.JANGAR_AGENT_RUNNER_IMAGE` (or `env.vars.JANGAR_AGENT_IMAGE`) to a runner image.

Native orchestration runs are handled in-cluster and do not require external workflow engines. For Codex reruns or
system-improvement workflows, use the native OrchestrationRun path by setting
`workflowRuntime.native.rerunOrchestration` and/or `workflowRuntime.native.systemImprovementOrchestration`
(override namespaces with the matching `workflowRuntime.native.*Namespace` values). Ensure the referenced
Orchestration exists (for example, `codex-autonomous`).
Native orchestration currently supports `AgentRun`, `ToolRun`, `SubOrchestration`, and `ApprovalGate` steps;
other step kinds require adapters or future controller extensions.

Optional: submit runs with `agentctl`:
```bash
agentctl run submit --agent codex-agent --impl codex-impl-sample --runtime workflow --workload-image ghcr.io/proompteng/codex-agent:latest
```
If you enable the gRPC port (`grpc.enabled=true`), you can port-forward it:
```bash
kubectl -n agents port-forward svc/agents 50051:50051 &
```
Keep the gRPC service ClusterIP-only and expose it externally only via a controlled gateway or mesh.

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

## Crossplane
Crossplane is not supported by Agents. Uninstall it before installing the native chart so the
native CRDs remain the only definitions.

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
| `grpc.enabled` | Expose gRPC ClusterIP service for agentctl | `false` |
| `grpc.port` | Container gRPC port | `50051` |
| `grpc.servicePort` | Service gRPC port | `50051` |
| `grpc.serviceType` | gRPC Service type (cluster-only) | `ClusterIP` |
| `serviceAccount.create` | Create service account | `true` |
| `serviceAccount.name` | Service account name override | `""` |
| `rbac.create` | Create RBAC | `true` |
| `rbac.clusterScoped` | Use ClusterRole/ClusterRoleBinding for multi-namespace reconciliation | `false` |
| `database.url` | Database URL for Jangar | `""` |
| `database.secretRef.name` | Secret containing database URL | `""` |
| `database.caSecret.name` | Secret containing DB CA cert | `""` |
| `envFromSecretRefs` | Secret names to load as envFrom | `[]` |
| `envFromConfigMapRefs` | ConfigMap names to load as envFrom | `[]` |
| `workflowRuntime.namespace` | Default workflow namespace for Codex workflows | `""` |
| `workflowRuntime.native.rerunOrchestration` | Orchestration name for native Codex reruns | `""` |
| `workflowRuntime.native.rerunOrchestrationNamespace` | Namespace for native Codex rerun orchestration | `""` |
| `workflowRuntime.native.systemImprovementOrchestration` | Orchestration name for native system improvement runs | `""` |
| `workflowRuntime.native.systemImprovementOrchestrationNamespace` | Namespace for native system improvement orchestration | `""` |
| `controller.enabled` | Enable Agents controller loop | `true` |
| `controller.namespaces` | Namespaces to watch | `['<release-namespace>']` |
| `controller.concurrency.perNamespace` | Max running AgentRuns per namespace | `10` |
| `controller.concurrency.perAgent` | Max running AgentRuns per Agent | `5` |
| `controller.concurrency.cluster` | Max running AgentRuns cluster-wide | `100` |
| `orchestrationController.enabled` | Enable Orchestration controller loop | `true` |
| `orchestrationController.namespaces` | Namespaces to watch for OrchestrationRuns | `['<release-namespace>']` |
| `supportingController.enabled` | Enable supporting primitives controller | `true` |
| `supportingController.namespaces` | Namespaces to watch for schedules/artifacts/workspaces | `['<release-namespace>']` |
| `agentComms.enabled` | Enable NATS agent-comms subscriber | `false` |
| `agentComms.nats.url` | NATS URL | `""` |
| `livenessProbe.enabled` | Enable liveness probe | `true` |
| `readinessProbe.enabled` | Enable readiness probe | `true` |
| `logging.level` | Log level for Jangar | `info` |

See `values.yaml`, `values-local.yaml`, `values-dev.yaml`, and `values-prod.yaml` for full options.
