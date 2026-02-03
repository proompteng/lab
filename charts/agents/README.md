# Agents Helm Chart

Production Helm chart for the Agents control plane (Jangar) plus the full Agents CRD suite.

Run AI workflows natively in Kubernetes with operator-driven orchestration, Jobs/Pods runtime, and first-class CRDs for agents, tools, approvals, schedules, artifacts, and workspaces.

## Try it now (5 minutes)
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

## Kind quickstart (end-to-end)
Spin up a local kind cluster, install Postgres, deploy the chart, and run the
smoke AgentRun with a single command:

```bash
scripts/agents/kind-e2e.sh
```

The script builds a local Jangar image first (running `bun install` + `bun run build`
if `.output` is missing), then loads the image into kind.

Environment variables you can override:
- `CLUSTER_NAME` (default: `agents`)
- `NAMESPACE` (default: `agents`)
- `POSTGRES_RELEASE` (default: `agents-postgres`)
- `POSTGRES_USER` (default: `agents`)
- `POSTGRES_PASSWORD` (default: `agents`)
- `POSTGRES_DB` (default: `agents`)
- `CHART_PATH` (default: `charts/agents`)
- `VALUES_FILE` (default: `charts/agents/values-kind.yaml`)
- `SECRET_NAME` (default: `jangar-db-app`)
- `SECRET_KEY` (default: `uri`)
- `KUBECTL_CONTEXT` (default: `kind-<cluster>`)
- `IMAGE_REPOSITORY` (default: `jangar-local`)
- `IMAGE_TAG` (default: `kind`)
- `BUILD_IMAGE` (default: `1`, set to `0` to skip the Docker build)

## Why teams use this chart
- **Operator-native orchestration**: run workflows with Kubernetes Jobs/Pods (no external workflow engine required).
- **Batteries-included CRDs**: agents, tools, orchestration, approvals, schedules, artifacts, workspaces, and more.
- **Small blast radius**: no ingress, no bundled database, no migrations job baked in.
- **Production-minded defaults**: RBAC, optional PDBs, network policy, HPA toggles, gRPC service option.
- **Artifact Hub ready**: metadata, images, CRD docs, and examples included.

## What this chart installs
- Jangar control-plane Deployment + Service
- Controllers and CRDs for:
  - Agents (Agent, AgentRun, AgentProvider)
  - Orchestration (Orchestration, OrchestrationRun)
  - Tools (Tool, ToolRun)
  - Signals (Signal, SignalDelivery)
  - Schedules (Schedule)
  - Artifacts (Artifact)
  - Workspaces (Workspace)
  - Supporting primitives (ApprovalPolicy, Budget, SecretBinding, ImplementationSpec, ImplementationSource, Memory)

## Architecture (at a glance)
- **Control plane**: Jangar reconciles CRDs and schedules runtime Jobs/Pods.
- **Runtime**: Agents and tools run as Jobs/Pods with input/run spec ConfigMaps.
- **Storage**: Agent memory configured per Memory CRD and its Secret.
- **Security**: RBAC, namespace scoping, optional network policy.

## Requirements
- Kubernetes 1.25+
- Helm 3.12+
- Postgres-compatible database connection string for Jangar

## Configuration essentials
### Database
Provide one of:
- `database.url` (inline)
- `database.secretRef` (existing Secret)
- `database.createSecret.enabled=true` with `database.url`

Agent memory backends are configured separately via the `Memory` CRD.

### Controller scope
- Single namespace: default
- Multi-namespace: set `controller.namespaces` and `rbac.clusterScoped=true`

### gRPC service (optional)
Enable gRPC for agentctl or in-cluster clients:
- `grpc.enabled=true`
- Set `env.vars.JANGAR_GRPC_TOKEN` to require a shared token

### Migrations
Automatic migrations are enabled by default. To skip:
- `env.vars.JANGAR_MIGRATIONS=skip`

### Codex auth secret (optional)
If you mount a Codex auth secret, avoid `/root/.codex` because secret volumes are read-only and Codex writes caches
there. Use a dedicated mount path and let the controller set `CODEX_AUTH` to it.

Example:
```bash
helm upgrade agents charts/agents --namespace agents --reuse-values \
  --set controller.authSecret.name=codex-auth \
  --set controller.authSecret.key=auth.json \
  --set controller.authSecret.mountPath=/var/run/secrets/codex
```

## Example production values
```yaml
image:
  repository: ghcr.io/proompteng/jangar
  tag: 0.9.0

database:
  secretRef:
    name: jangar-postgres
    key: url

controller:
  namespaces:
    - agents

rbac:
  clusterScoped: false

grpc:
  enabled: true

podDisruptionBudget:
  enabled: true

networkPolicy:
  enabled: true
```

## agentctl (optional)
Submit runs with agentctl (kube mode by default):
```bash
agentctl run submit \
  --agent codex-agent \
  --impl codex-impl-sample \
  --runtime workflow \
  --workload-image registry.ide-newton.ts.net/lab/codex-universal:latest
```

Replace the workload image with your own agent-runner build.
If your agent-runner uses NATS for context streaming, set `NATS_URL` in the AgentProvider `envTemplate`.

## Native orchestration
Native orchestration runs in-cluster and supports:
- `AgentRun`
- `ToolRun`
- `SubOrchestration`

Enable reruns or system-improvement flows using:
- `workflowRuntime.native.rerunOrchestration`
- `workflowRuntime.native.systemImprovementOrchestration`

## Security notes
- Keep `service.type=ClusterIP` and expose via a gateway/mesh if needed.
- Use `database.secretRef` and dedicated DB credentials per environment.
- Scope controllers to specific namespaces unless you need cluster-wide control.
- Prefer image digests in production (`values-prod.yaml`).

## Publishing (OCI)
```bash
bun packages/scripts/src/agents/publish-chart.ts
```

## Values
See `values.yaml` and `values.schema.json` for full configuration.

## Support
Open issues or discussions in the repo if you want:
- new CRDs
- additional runtime adapters
- better tooling around agentctl or observability
