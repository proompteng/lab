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
kubectl apply -n agents -f charts/agents/examples/versioncontrolprovider-github.yaml
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
  - Version control providers (VersionControlProvider)
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
- Wildcard: set `controller.namespaces=["*"]` and `rbac.clusterScoped=true`

#### Namespaced vs cluster-scoped install matrix
| Install mode | controller.namespaces | rbac.clusterScoped | RBAC scope |
| --- | --- | --- | --- |
| Namespaced (single) | `[]` or `["agents"]` | `false` | Role + RoleBinding |
| Multi-namespace (explicit) | `["team-a", "team-b"]` | `true` | ClusterRole + ClusterRoleBinding |
| Wildcard (all namespaces) | `["*"]` | `true` | ClusterRole + ClusterRoleBinding (namespace list/watch) |

### Default scheduling for job pods
Set controller-wide defaults for Job pods using `controller.defaultWorkload`. These defaults apply when the
AgentRun runtime config does not specify a value.

Common fields:
- `controller.defaultWorkload.nodeSelector`
- `controller.defaultWorkload.affinity`
- `controller.defaultWorkload.priorityClassName`
- `controller.defaultWorkload.schedulerName`

Per-run overrides live under `spec.runtime.config` on the AgentRun and take precedence over defaults.

### gRPC service (optional)
Enable gRPC for agentctl or in-cluster clients:
- `grpc.enabled=true`
- Set `env.vars.JANGAR_GRPC_TOKEN` to require a shared token

### Observability (Prometheus + Grafana)
The chart ships a Prometheus scrape endpoint and an optional ServiceMonitor plus a Grafana dashboard ConfigMap.
- Metrics endpoint: `metrics.enabled=true` (default) exposes `metrics.path` (default `/metrics`).
- Metrics service: `metrics.service.enabled=true` publishes a `*-metrics` Service on `metrics.service.port`.
- ServiceMonitor: set `metrics.serviceMonitor.enabled=true` and add labels/annotations as needed.
- Grafana dashboard: `metrics.dashboards.enabled=true` creates a ConfigMap labeled for Grafana sidecars.

### Migrations
Automatic migrations are enabled by default. To skip:
- `env.vars.JANGAR_MIGRATIONS=skip`

### Codex auth secret (optional)
The controller mounts a writable `emptyDir` at `controller.authSecret.mountPath` (default `/root/.codex`) and then
mounts the secret file at `auth.json` inside it. It also sets `CODEX_HOME` and `CODEX_AUTH` for the runner pods.

Example:
```bash
helm upgrade agents charts/agents --namespace agents --reuse-values \
  --set controller.authSecret.name=codex-auth \
  --set controller.authSecret.key=auth.json
```

### Version control providers
Define a VersionControlProvider resource to decouple repo access from issue intake. This is required for
agent runtimes that clone, commit, push, or open pull requests. Pair it with a SecretBinding that
allows the provider's secret.

Auth options (VersionControlProvider `spec.auth`):
- `method: token` with `token.type: pat | fine_grained | api_token | access_token`
- `method: app` (GitHub only) with `appId`, `installationId`, and `privateKeySecretRef`
- `method: ssh` with `privateKeySecretRef` (optional `knownHostsConfigMapRef`)

Repository policy (VersionControlProvider `spec.repositoryPolicy`):
- `allow` and `deny` accept `*` wildcards (for example, `acme/*`).
- Deny rules win. When an allow list is set, repositories must match it.
- Runs with `spec.vcsPolicy.mode` other than `none` are blocked if the repository is not allowed.

Token scopes & expiry guidance:
- GitHub App installation tokens expire after ~1 hour (default 3600s). Use `spec.auth.app.tokenTtlSeconds` if you need a shorter TTL.
- GitHub fine-grained PATs should include repository contents + pull request scopes for write flows.
- GitLab tokens must include `read_repository` for read-only workflows and `write_repository` for pushes/merges.
- Bitbucket access tokens should include repository read/write scopes matching your intended mode.
- Gitea API tokens need repo access; set `spec.auth.username` if your HTTPS auth requires a specific account name.
- If `spec.auth.token.type` is omitted, the controller applies the provider default (e.g., `fine_grained` for GitHub).
- Deprecated token types surface Warning conditions on the provider and runs; configure overrides in values.

Values example (deprecated token types):
```yaml
controller:
  vcsProviders:
    enabled: true
    deprecatedTokenTypes:
      github:
        - pat
```

Branch naming defaults (VersionControlProvider `spec.defaults`):
- `branchTemplate` controls deterministic head branch names (e.g. `codex/{{issueNumber}}`).
- `branchConflictSuffixTemplate` appends a suffix when another active run uses the same branch.

Example token auth (GitHub fine-grained PAT):
```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: VersionControlProvider
metadata:
  name: github
spec:
  provider: github
  apiBaseUrl: https://api.github.com
  cloneBaseUrl: https://github.com
  webBaseUrl: https://github.com
  auth:
    method: token
    token:
      secretRef:
        name: codex-github-token
        key: token
      type: fine_grained
```

Example GitHub App auth (short-lived tokens):
```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: VersionControlProvider
metadata:
  name: github-app
spec:
  provider: github
  apiBaseUrl: https://api.github.com
  cloneBaseUrl: https://github.com
  webBaseUrl: https://github.com
  auth:
    method: app
    app:
      appId: "12345"
      installationId: "7890"
      privateKeySecretRef:
        name: github-app-key
        key: privateKey
      tokenTtlSeconds: 3600
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
  vcsProviders:
    enabled: true
    deprecatedTokenTypes:
      github:
        - pat

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

## Runner image defaults
The chart sets `JANGAR_AGENT_RUNNER_IMAGE` from `runner.image.*` to avoid missing workload image errors.
Override `runner.image.repository`, `runner.image.tag`, or `runner.image.digest` to point at your own build.

## Job TTL behavior
Jobs launched by the controller use `controller.jobTtlSecondsAfterFinished` as the default TTL (seconds).
The controller applies TTL only after it records the AgentRun/workflow status to avoid cleanup races.
Set `controller.jobTtlSecondsAfterFinished=0` to disable job cleanup, or override per run via
`spec.runtime.config.ttlSecondsAfterFinished`. Values are clamped to 30s–7d for safety.

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

## Admission control
- Configure backpressure with `controller.queue.*` and `controller.rate.*` in `values.yaml`.
- Queue limits cap pending AgentRuns; rate limits cap submit throughput.

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
