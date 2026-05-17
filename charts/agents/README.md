# Agents Helm Chart

Agents installs **Jangar**, a Kubernetes-native control plane for running agent and automation work as normal Kubernetes resources.

If you already understand Deployments and Jobs, this is the shortest mental model:

- You create an `AgentRun` custom resource when you want work done.
- Jangar watches that resource and launches Kubernetes Jobs/Pods to do the work.
- The run status is written back to the `AgentRun`, so Kubernetes stays the source of truth.

The chart is published on Artifact Hub:

- Artifact Hub: <https://artifacthub.io/packages/helm/agents/agents>
- OCI chart: `oci://ghcr.io/proompteng/charts/agents`
- Current chart version: `0.9.15`

## Start Here

Use the local end-to-end path first. It builds a Jangar image from this repository, creates a kind cluster, installs Postgres, deploys the chart, submits a smoke `AgentRun`, and waits for that run to succeed.

```bash
git clone https://github.com/proompteng/lab.git
cd lab

scripts/agents/kind-e2e.sh
```

Expected final output:

```text
Agents chart kind run complete.
```

Verify the result yourself:

```bash
kubectl --context kind-agents -n agents get deploy,pods,svc
kubectl --context kind-agents -n agents get agentrun agents-workflow-smoke -o jsonpath='{.status.phase}{"\n"}'
kubectl --context kind-agents -n agents describe agentrun agents-workflow-smoke
kubectl --context kind-agents -n agents get jobs
```

Clean up the local cluster:

```bash
kind delete cluster --name agents
```

### What The Script Does

`scripts/agents/kind-e2e.sh` is intentionally more useful than a render-only demo:

1. Creates or reuses a kind cluster named `agents`.
2. Builds the Agents container images for the control plane, controllers, and Codex runner.
3. Loads that image into kind.
4. Installs a disposable `pgvector/pgvector` Postgres deployment and creates the required `vector` and `pgcrypto` extensions.
5. Creates the database URL Secret the chart expects.
6. Installs this chart with `charts/agents/values-kind.yaml`, which grants CRD discovery RBAC and uses `/health`
   as the local readiness gate.
7. Applies the smoke `AgentProvider`, `Agent`, `ImplementationSpec`, and `AgentRun`.
8. Waits for `agentrun/agents-workflow-smoke` to report `Succeeded`.

The important point: this proves the chart can do real controller work, not just pass `helm template`.

## Install The Published Chart

Use this path when you already have:

- Kubernetes `1.25+`
- Helm with OCI registry support
- A Postgres-compatible database URL
- An Agents control-plane image your cluster can pull
- An Agents Codex runner image your cluster can pull for `AgentRun` Jobs

The chart package is public. The runtime images are an operator decision: the local quickstart builds an image for kind, while production should use your promoted image tags and digests.

Create the namespace and database Secret:

```bash
kubectl create namespace agents

kubectl -n agents create secret generic agents-db-app \
  --from-literal=url='postgresql://USER:PASSWORD@HOST:5432/agents?sslmode=require'
```

Create a values file for your environment:

```yaml
# agents-values.yaml
image:
  repository: registry.example.com/platform/agents-control-plane
  tag: 2026-05-05
  digest: sha256:REPLACE_WITH_AGENTS_CONTROL_PLANE_IMAGE_DIGEST
  pullSecrets:
    - registry-cred

runner:
  image:
    repository: registry.example.com/platform/agents-codex-runner
    tag: 2026-05-05
    digest: sha256:REPLACE_WITH_RUNNER_IMAGE_DIGEST
    pullSecrets:
      - registry-cred

imagePolicy:
  requireDigest: true

database:
  secretRef:
    name: agents-db-app
    key: url

controller:
  namespaces:
    - agents

controllers:
  enabled: true

orchestrationController:
  enabled: true

supportingController:
  enabled: true

rbac:
  clusterScoped: true

readinessProbe:
  # Use /health for first install. /ready also checks production dependencies such
  # as execution trust and memory embeddings; enable it after those are configured.
  path: /health
```

Install:

```bash
helm upgrade --install agents oci://ghcr.io/proompteng/charts/agents \
  --version 0.9.13 \
  --namespace agents \
  --values agents-values.yaml \
  --wait
```

Check the control plane:

```bash
kubectl -n agents rollout status deployment/agents --timeout=180s
kubectl -n agents get deploy,svc,pods

kubectl -n agents port-forward svc/agents 8080:80
curl -sf http://127.0.0.1:8080/health
```

Run the chart smoke examples from the published package:

```bash
helm pull oci://ghcr.io/proompteng/charts/agents --version 0.9.13 --untar

kubectl -n agents apply -f agents/examples/agentprovider-smoke.yaml
kubectl -n agents apply -f agents/examples/agent-smoke.yaml
kubectl -n agents apply -f agents/examples/implementationspec-smoke.yaml
kubectl -n agents apply -f agents/examples/agentrun-workflow-smoke.yaml

kubectl -n agents wait --for=condition=Succeeded agentrun/agents-workflow-smoke --timeout=300s
kubectl -n agents describe agentrun agents-workflow-smoke
```

## First Concepts

You do not need to understand every CRD before installing the chart. These are the pieces that matter first:

| Concept                | What it means                                                                       | First example                                 |
| ---------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| Jangar                 | The control plane installed by this chart. It watches CRDs and coordinates work.    | `Deployment/agents`                           |
| AgentRun               | One requested unit of work. This is what you create when you want something to run. | `examples/agentrun-workflow-smoke.yaml`       |
| Agent                  | A reusable worker profile. It points at an AgentProvider and can define defaults.   | `examples/agent-smoke.yaml`                   |
| AgentProvider          | How an agent is executed, such as a command, adapter, or runner entrypoint.         | `examples/agentprovider-smoke.yaml`           |
| ImplementationSpec     | The task text and required inputs for a run.                                        | `examples/implementationspec-smoke.yaml`      |
| Runner image           | The image used by Jobs/Pods launched for an AgentRun.                               | `runner.image.*`                              |
| Memory                 | Optional storage configuration for agents that need persistent context.             | `examples/memory-sample.yaml`                 |
| VersionControlProvider | Optional repo access configuration for runs that clone, commit, push, or open PRs.  | `examples/versioncontrolprovider-github.yaml` |

## What Gets Installed

The chart installs:

- Jangar control-plane `Deployment` and HTTP `Service`
- Optional gRPC `Service`
- Optional controllers deployment for reconciliation/runtime work
- Optional metrics `Service`, `ServiceMonitor`, and Grafana dashboard ConfigMap
- RBAC for the selected namespace or cluster scope
- CRDs for agents, runs, providers, implementation specs, memory, version control providers, orchestration, tools, signals, schedules, artifacts, workspaces, approvals, budgets, and secret bindings

The chart does **not** install:

- A production database
- An ingress or public load balancer
- A global cluster-wide controller unless you ask for it
- Production secrets
- Your private runner image

That is deliberate. The chart should be safe to install into a namespace and then expand from there.

## Common Tasks

### Render Before Installing

```bash
helm template agents oci://ghcr.io/proompteng/charts/agents \
  --version 0.9.13 \
  --namespace agents \
  --values agents-values.yaml
```

### Run Helm Test

The chart includes an opt-in test Pod that curls the in-cluster health endpoint through the rendered Service.

```bash
helm upgrade --install agents oci://ghcr.io/proompteng/charts/agents \
  --version 0.9.13 \
  --namespace agents \
  --values agents-values.yaml \
  --set tests.enabled=true \
  --wait

helm test agents --namespace agents
```

### Use A Local Chart Checkout

```bash
helm lint charts/agents
helm template agents charts/agents --namespace agents --values charts/agents/values-kind.yaml
helm upgrade --install agents charts/agents --namespace agents --values charts/agents/values-kind.yaml --wait
```

For a full local run with a real cluster and smoke `AgentRun`, use `scripts/agents/kind-e2e.sh` instead of these render/install-only commands.

## Production Configuration

### Images

Production should pin image tags and digests:

```yaml
image:
  repository: registry.example.com/platform/agents-control-plane
  tag: 2026-05-05
  digest: sha256:...
  pullSecrets:
    - registry-cred

runner:
  image:
    repository: registry.example.com/platform/agent-runner
    tag: 2026-05-05
    digest: sha256:...
    pullSecrets:
      - registry-cred

imagePolicy:
  requireDigest: true
```

`imagePolicy.requireDigest=true` rejects mutable chart-managed images at render time. It covers the control plane, runner image defaults, Argo CD hooks, Helm tests, and legacy runtime image values.

### Database

Use an existing Secret for production:

```yaml
database:
  secretRef:
    name: agents-db-app
    key: url
  caSecret:
    name: agents-db-ca
    key: ca.crt
```

Use `database.createSecret.enabled=true` only when you intentionally want Helm to own the database URL Secret.

### Controller Scope

Start with one watched namespace and cluster-scoped RBAC:

```yaml
controller:
  namespaces:
    - agents
rbac:
  clusterScoped: true
```

The controller needs cluster-scoped read access to CustomResourceDefinitions so `/ready` can distinguish missing
CRDs from missing RBAC. Use namespace-scoped RBAC only when you intentionally keep the readiness probe on `/health`
or provide that CRD read permission outside this chart.

Watch multiple namespaces by listing them:

```yaml
controller:
  namespaces:
    - team-a
    - team-b
rbac:
  clusterScoped: true
```

Valid scope patterns:

| Mode                                     | Namespace list          | `rbac.clusterScoped` |
| ---------------------------------------- | ----------------------- | -------------------- |
| First install / production readiness     | omitted or `["agents"]` | `true`               |
| Namespace Role only, `/health` readiness | omitted or `["agents"]` | `false`              |
| Multiple namespaces                      | `["team-a", "team-b"]`  | `true`               |
| All namespaces                           | `["*"]`                 | `true`               |

Invalid combinations fail at render time, including empty scope lists, wildcard mixed with real namespace names, and multi-namespace scope with namespaced RBAC.

### Runner Defaults

The controller passes runner image defaults to AgentRun Jobs through `AGENTS_AGENT_RUNNER_IMAGE`.

Precedence:

1. `env.vars.AGENTS_AGENT_RUNNER_IMAGE`
2. `runner.image.*`
3. `runtime.agentRunnerImage` legacy fallback

Prefer `runner.image.*` for new installs.

### Availability

Enable disruption protection and controller rollout safety:

```yaml
podDisruptionBudget:
  enabled: true
  maxUnavailable: 1

controllers:
  enabled: true
  podDisruptionBudget:
    enabled: true
    maxUnavailable: 1
  deploymentStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
```

### Observability

Metrics are enabled by default. Add ServiceMonitor and dashboard support when your cluster has Prometheus Operator and a Grafana sidecar:

```yaml
metrics:
  enabled: true
  service:
    enabled: true
  serviceMonitor:
    enabled: true
    labels:
      release: kube-prometheus-stack
  dashboards:
    enabled: true
```

### Network Policy

The chart can create a NetworkPolicy, but you must set rules that match your cluster. Start restrictive and explicitly allow Postgres, Kubernetes API, registry, and any external APIs your runners need.

```yaml
networkPolicy:
  enabled: true
  policyTypes:
    - Ingress
    - Egress
  ingress: []
  egress: []
```

### Rollouts On External Secret Changes

Helm cannot safely read live Secret or ConfigMap payloads during template rendering. If a pod depends on externally managed Secret/ConfigMap data and you want deterministic rollouts, enable explicit checksums:

```yaml
rolloutChecksums:
  enabled: true
  secrets:
    - name: agents-db-app
      namespace: agents
      checksum: d34db33fd34db33fd34db33fd34db33fd34db33fd34db33fd34db33fd34db33f
```

Generate a stable Secret payload hash:

```bash
kubectl -n agents get secret agents-db-app -o json |
  jq -cS '{data: .data, binaryData: .binaryData}' |
  sha256sum | awk '{print $1}'
```

## AgentRun Examples

### Minimal Smoke Workflow

This is the example used by the end-to-end kind script:

```bash
kubectl -n agents apply -f charts/agents/examples/agentprovider-smoke.yaml
kubectl -n agents apply -f charts/agents/examples/agent-smoke.yaml
kubectl -n agents apply -f charts/agents/examples/implementationspec-smoke.yaml
kubectl -n agents apply -f charts/agents/examples/agentrun-workflow-smoke.yaml
kubectl -n agents wait --for=condition=Succeeded agentrun/agents-workflow-smoke --timeout=300s
```

### Version Control Runs

Runs that clone, commit, push, or open pull requests need a `VersionControlProvider`:

```bash
kubectl -n agents apply -f charts/agents/examples/versioncontrolprovider-github.yaml
```

A GitHub App example is available at `charts/agents/examples/versioncontrolprovider-github-app.yaml`.

Token guidance:

- Prefer GitHub App installation tokens for production.
- Fine-grained PATs need repository contents and pull request scopes for write flows.
- Deny rules win over allow rules in repository policy.
- Runs with `spec.vcsPolicy.mode` other than `none` are blocked if the repository is not allowed.

### agentctl

`agentctl` can submit runs through Kubernetes or gRPC. The chart exposes gRPC with:

```yaml
grpc:
  enabled: true
  servicePort: 50051
```

Example run submission:

```bash
agentctl run submit \
  --agent smoke-agent \
  --impl smoke-impl \
  --runtime workflow \
  --workload-image busybox:1.36
```

## Troubleshooting

### Pod Is `ImagePullBackOff`

The cluster cannot pull `image.*` or `runner.image.*`.

```bash
kubectl -n agents describe pod -l app.kubernetes.io/instance=agents
kubectl -n agents get events --sort-by=.lastTimestamp | tail -40
```

Fix the image repository/tag/digest or add the pull secret name under `image.pullSecrets` and `runner.image.pullSecrets`.

### Deployment Is `CrashLoopBackOff`

Check database connectivity and migrations first:

```bash
kubectl -n agents logs deploy/agents --tail=200
kubectl -n agents get secret agents-db-app -o jsonpath='{.data.url}' | base64 -d
```

Common causes:

- Database host is not reachable from inside the cluster.
- Database credentials are wrong.
- TLS mode or CA Secret does not match the database.
- Migrations are disabled before schema exists.

### AgentRun Does Not Finish

```bash
kubectl -n agents describe agentrun agents-workflow-smoke
kubectl -n agents get jobs,pods
kubectl -n agents logs job/<job-name>
kubectl -n agents logs deploy/agents-controllers --tail=200
```

Common causes:

- `controllers.enabled=false` in an install that expects controller-launched Jobs.
- Runner image cannot be pulled.
- RBAC scope does not include the namespace where the AgentRun lives.
- Admission policy rejected the run.

### Helm Render Fails

The chart validates unsafe or ambiguous values at render time. Read the error message first, then check:

```bash
helm template agents charts/agents --namespace agents --values agents-values.yaml --debug
```

Frequent render failures:

- `imagePolicy.requireDigest=true` without image digests.
- Empty namespace scope arrays.
- Multi-namespace scope without cluster-scoped RBAC.
- Managed gRPC env vars overridden with conflicting values.
- `rolloutChecksums.enabled=true` without checksums for referenced external Secrets/ConfigMaps.

## Reference

### High-Value Values

| Value                                                                | Purpose                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `image.repository`, `image.tag`, `image.digest`                      | Default Jangar image used by the control-plane and controllers.           |
| `controlPlane.image.*`, `controllers.image.*`                        | Optional per-deployment overrides when those images differ.               |
| `runner.image.repository`, `runner.image.tag`, `runner.image.digest` | Default image for AgentRun Jobs.                                          |
| `imagePolicy.requireDigest`                                          | Require immutable image digests for chart-managed images.                 |
| `database.secretRef.*`                                               | Existing database URL Secret.                                             |
| `database.caSecret.*`                                                | Optional Postgres CA certificate Secret.                                  |
| `controller.namespaces`                                              | Namespaces the main controller watches.                                   |
| `orchestrationController.namespaces`                                 | Namespaces the orchestration controller watches.                          |
| `supportingController.namespaces`                                    | Namespaces supporting controllers watch.                                  |
| `rbac.clusterScoped`                                                 | Use ClusterRole/ClusterRoleBinding instead of namespace Role/RoleBinding. |
| `controllers.enabled`                                                | Run the controller deployment.                                            |
| `grpc.enabled`                                                       | Expose gRPC support for in-cluster clients and agentctl.                  |
| `metrics.serviceMonitor.enabled`                                     | Create a ServiceMonitor.                                                  |
| `podDisruptionBudget.enabled`                                        | Create a PDB for the control plane.                                       |
| `controllers.podDisruptionBudget.enabled`                            | Create a PDB for controllers.                                             |
| `tests.enabled`                                                      | Render the optional Helm test Pod.                                        |

See `values.yaml` and `values.schema.json` for the full contract.

### Publishing The Chart

Package and validate locally:

```bash
bun packages/scripts/src/agents/publish-chart.ts --dry-run
```

Publish to GHCR:

```bash
bun packages/scripts/src/agents/publish-chart.ts
```

The repository workflow also pushes Artifact Hub OCI metadata and waits until Artifact Hub reports the published version as latest.

Signed publishing uses Helm provenance files. Set:

- `AGENTS_CHART_SIGN=true`
- `AGENTS_CHART_SIGN_KEY`
- `AGENTS_CHART_SIGN_KEYRING` if needed
- `AGENTS_CHART_SIGN_PASSPHRASE_FILE` if needed

## Support

Open an issue with:

- Chart version
- Kubernetes version
- Helm version
- Values file with secrets removed
- `helm template ... --debug` output for render issues
- Relevant `kubectl describe`, `kubectl logs`, and `kubectl get events` output for runtime issues
