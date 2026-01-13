# Agents Helm Chart Design

Status: Draft (2026-01-13)

## Context
The current `charts/agents` chart bundles control-plane deployment plus CRDs and several optional add-ons.
Today it:
- Ships SQL migration scripts inside the chart.
- Hardcodes memory to Postgres.
- Bakes GitHub-only fields into the Agent CRD.
- Includes multiple optional resources (ingress, embedded Postgres, backups, migrations job) that are not required for a minimal control plane.

We want a minimal, provider-agnostic control plane chart that installs cleanly on minikube, kind, and standard Kubernetes clusters, and is publishable on Artifact Hub.

## Goals
- Provide a minimal, installable Helm chart for the Jangar control plane plus CRDs.
- Keep the base chart portable across minikube, kind, and managed clusters.
- Remove GitHub-only coupling from CRDs; support GitHub Issues and Linear via an abstract ImplementationSpec.
- Make memory provider-agnostic via a Memory CRD.
- Move SQL migrations into the Jangar image (not shipped in the chart).
- Follow Helm and Artifact Hub best practices for a public chart.

## Non-goals
- Bundling a database or backups in the core chart.
- Shipping ingress configuration (left to the platform/cluster).
- Designing a fully featured integrations operator in this doc.
- Defining every provider schema detail (only the minimum for extensibility).

## Requirements (from request)
- Installable on minikube, kind, and regular clusters.
- No outdated features like ingress in the chart.
- CRDs declared in the existing `charts/agents` chart.
- SQL scripts must not be packaged in the chart; Jangar owns migrations.
- AgentRun specifies execution coordinates; Agent defines only agent-level defaults.
- Implementation spec abstracts GitHub/Linear specifics away from Agent/AgentRun.
- Memory provider must be abstracted via a Memory CRD.
- Remove unnecessary chart resources.
- Align with Helm/Artifact Hub best practices.

## Proposed Chart Scope (Minimal Control Plane)
Resources to keep:
- Deployment: Jangar control plane.
- Service: ClusterIP.
- ServiceAccount + Role/RoleBinding (namespaced).
- Secrets/ConfigMaps needed for configuration (no SQL payloads).
- CRDs in `charts/agents/crds`.

Resources to remove from the base chart:
- Ingress.
- Embedded Postgres StatefulSet + Service + PVC.
- Migrations Job + SQL ConfigMap + `files/sql`.
- Backup CronJob + backup PVC.
- Optional HPA/PDB/NetworkPolicy (move to an optional "extras" overlay or separate chart if still desired).

Mermaid: chart scope overview
```mermaid
graph TD
  subgraph Helm Chart: agents
    CRDs[CRDs<br/>Agent, AgentRun, AgentProvider,<br/>ImplementationSpec, Memory]
    Deploy[Jangar Deployment]
    Svc[ClusterIP Service]
    SA[ServiceAccount + RBAC]
    Cfg[Config/Secret]
  end
  Deploy --> Svc
  Deploy --> Cfg
  SA --> Deploy
  CRDs --> Deploy
```

Local cluster usage (minikube/kind):
- Keep `service.type=ClusterIP` and rely on `kubectl port-forward` for local access.
- Provide a `values-local.yaml` example that does not assume LoadBalancer/Ingress.

## Control Plane (Jangar)
- Jangar is packaged as the main deployment in this chart.
- Database migrations run inside Jangar (or a Jangar-owned init path) using SQL shipped in the image.
- Chart only passes database connection configuration and migration toggles (e.g., `JANGAR_MIGRATIONS=auto`).

### Jangar as Controller + Control Plane
Jangar is the reconciler for all Agents CRDs. No separate operator is required as long as Jangar runs.
It provides:
- Controller manager (leader-elected) that owns reconciliation loops.
- Runtime adapter layer (Argo/Temporal/Job/Custom) for execution.
- Integration layer for GitHub + Linear ingestion into ImplementationSpec.
- Status/condition management and event emission.

#### Reconciliation loops (high-level)
- `AgentRun` reconciler:
  - Resolve `spec.agentRef` and `spec.implementationRef` (or inline).
  - Validate `spec.execution.coordinates` + `spec.workload`.
  - Resolve provider templates and render an execution spec for `agent-runner`.
  - Select runtime adapter and submit workload.
  - Update `status.phase`, `status.conditions`, timestamps, and runtime identifiers.
- `ImplementationSpec` reconciler:
  - Validate schema, normalize plaintext `spec.text`.
  - Track provenance (`spec.source`) and update conditions when upstream changes.
- `ImplementationSource` reconciler:
  - Connect to GitHub/Linear (webhook or poll).
  - Normalize external issues to ImplementationSpec objects (create/update/delete).
  - Maintain sync cursor and emit reconciliation events.
- `Memory` reconciler:
  - Validate connection secrets and publish capability metadata.
  - Optionally run health checks for memory backends.

#### Status model (suggested)
- Common conditions: `Ready`, `Accepted`, `InvalidSpec`, `InProgress`, `Succeeded`, `Failed`, `Blocked`.
- `AgentRun.status` includes:
  - `phase`: `Pending|Running|Succeeded|Failed|Cancelled`
  - `startedAt`, `finishedAt`
  - `runtimeRef`: opaque identifiers (workflow name/UID, job name, run ID)
  - `artifacts`: list of produced outputs (keys/paths)
- `ImplementationSpec.status` includes:
  - `syncedAt`, `sourceVersion`
  - `conditions` for provider sync

#### Lifecycle & safety
- Use finalizers on `AgentRun` to ensure runtime teardown on delete.
- Use ownerReferences when Jangar creates derived resources (if applicable).
- Leader election prevents duplicate runs in multi-replica deployments.
- Emit Kubernetes Events for submit/start/finish/failure.

#### Observability & operations
- Structured logs with run correlation (`agentRun.uid`, `implementationSpec.uid`).
- Metrics: reconcile duration, run latency, success/failure counts by runtime/provider.
- Configurable resync intervals and backoff for transient provider failures.

## CRD Redesign
All CRDs remain under `charts/agents/crds` and are cluster-scoped definitions.

Mermaid: CRD relationships
```mermaid
graph LR
  AgentRun -->|references| Agent
  Agent -->|references| AgentProvider
  Agent -->|optional| Memory
  AgentRun -->|executes| ImplementationSpec
  ImplementationSource -.->|creates/updates| ImplementationSpec
```

### Agent (v1alpha1)
Purpose: Default configuration and policy for an agent.
Key fields (conceptual):
- `spec.providerRef`: reference to AgentProvider.
- `spec.runtime`: runtime type + default settings (Argo/Temporal/Job/Custom).
- `spec.resources`: default CPU/memory/ephemeral.
- `spec.env`: default env vars.
- `spec.security`: allowlist of service accounts/secrets.
- `spec.memoryRef`: optional reference to Memory (default memory backend).
- `spec.defaults`: timeout/retry defaults for runs.

Removed from Agent:
- Repo/issue/implementation inputs.
- Payloads tied to GitHub events.

### AgentRun (v1alpha1)
Purpose: A single execution of an ImplementationSpec, including the exact coordinates of what to run.
Required fields:
- `spec.agentRef`: reference to Agent.
- `spec.implementationRef` or `spec.implementation.inline`: what to implement (required).
- `spec.execution.coordinates`: where the run happens.

Proposed `execution.coordinates`:
- `git.url`: repository URL (ssh or https).
- `git.ref`: branch/tag/commit SHA.
- `git.path`: optional subdirectory.
- `workspace`: optional workspace overrides (image, volume, etc).

Implementation spec linkage:
- `spec.implementationRef`: reference to ImplementationSpec (preferred).
- `spec.implementation.inline`: inline ImplementationSpec for ad-hoc runs.

Workload requirements:
- `spec.workload.image`: optional custom image for the agent execution environment.
- `spec.workload.resources`: CPU/memory/ephemeral overrides for this run.
- `spec.workload.volumes`: optional runtime volumes/scratch (runtime-agnostic).

Overrides:
- `spec.runtimeOverrides`: runtime-specific overrides (runtime-agnostic schema; examples may include Argo or Temporal).
- `spec.parameters`: arbitrary key-value parameters for the provider.
- `spec.secrets`: named secret refs allowed for this run.

Mermaid: execution flow
```mermaid
sequenceDiagram
  autonumber
  participant AR as AgentRun
  participant AG as Agent
  participant PR as AgentProvider
  participant J as Jangar
  participant RT as Runtime Adapter
  AR->>J: Submit run
  J->>AG: Resolve defaults
  J->>PR: Resolve provider template
  J->>RT: Create workflow/job
  RT-->>J: Status updates
  J-->>AR: Update status/conditions
```

### AgentProvider (v1alpha1)
Purpose: Define how to invoke the agent binary or runtime adapter.
Keep as-is with minimal cleanup:
- `spec.binary`
- `spec.argsTemplate`
- `spec.envTemplate`
- `spec.inputFiles`
- `spec.outputArtifacts`

No GitHub-specific templates in examples.

Custom agent images:
- AgentRun can supply `spec.workload.image` for the container image that hosts `/usr/local/bin/agent-runner`.
- Provide a Codex agent Dockerfile for reference at `apps/froussard/Dockerfile.codex`.

### ImplementationSpec (new CRD, v1alpha1)
Purpose: Provider-agnostic description of "what to implement".
Key fields:
- `spec.source`: optional origin info (provider + external ID + URL).
  - `provider`: `github` | `linear` | `manual` | `custom`
  - `externalId`: string (e.g., `owner/repo#123`, `LIN-123`)
  - `url`: canonical URL (optional)
- `spec.text`: plaintext requirements (initial format).
- `spec.summary`: short statement of intent.
- `spec.description`: long-form markdown (optional, future).
- `spec.acceptanceCriteria`: list of criteria.
- `spec.labels`: optional labels/tags.

### Integration (GitHub + Linear)
Add an `ImplementationSource` CRD that configures sync from GitHub Issues and Linear into ImplementationSpec objects. GitHub + Linear are the first integrations to ship. This keeps Agent and AgentRun generic while still enabling provider integrations. Jangar (or a lightweight integrations sidecar) is responsible for:
- Polling or webhook-driven ingestion from GitHub and Linear.
- Normalizing external issues into ImplementationSpec fields.
- Updating status/conditions on ImplementationSpec when upstream changes.

Mermaid: integration flow
```mermaid
sequenceDiagram
  autonumber
  participant GH as GitHub Issues
  participant LN as Linear
  participant IS as ImplementationSource
  participant J as Jangar
  participant IM as ImplementationSpec
  GH->>IS: Webhook/poll
  LN->>IS: Webhook/poll
  IS->>J: Normalized issue payload
  J->>IM: Create/update ImplementationSpec
  IM-->>J: Status/conditions
```

### Memory (new CRD, v1alpha1)
Purpose: Abstract memory/storage backend away from Postgres.
Key fields:
- `spec.type`: `postgres` | `redis` | `weaviate` | `pinecone` | `custom`.
- `spec.connection.secretRef`: secret with DSN/endpoint/credentials.
- `spec.capabilities`: `vector`, `kv`, `blob` (for routing features).
- `spec.default`: boolean (optional, if multiple memory backends exist).

Agent and AgentRun reference Memory by name, not by provider-specific fields.

## Values & Configuration (Helm)
The chart should include:
- `values.yaml` with sane defaults for a single-replica control plane.
- `values.schema.json` to validate configuration at install/upgrade/lint/template time.
- `values-local.yaml` example for minikube/kind (ClusterIP + port-forward).

Key values (conceptual):
- `image.repository`, `image.tag`, `image.digest`.
- `replicaCount`.
- `service.type`, `service.port`.
- `rbac.create`, `serviceAccount.create`.
- `env` and `envFromSecretRefs`.
- `resources`.
- `crds.install` (optional flag for `--skip-crds` parity).

No values for embedded database, migrations jobs, backups, or ingress.

## Compatibility & Installation
- Default chart installs cleanly on minikube/kind (ClusterIP + port-forward).
- No reliance on cloud-specific features (e.g., LoadBalancer or cloud storage).
- CRDs installed from `crds/` folder (not templated).

## Migration Plan (from current chart)
1. Replace existing CRDs in-place (v1alpha1) since current version is unused.
2. Update Jangar to expect the new v1alpha1 schema.
3. Update examples to match the new schema.
4. Remove SQL configmap and migrations job from the chart; move SQL into Jangar image.
5. Remove embedded Postgres and backup resources; document external database requirement via Memory CRD.

## Artifact Hub Readiness
Follow Helm and Artifact Hub guidance:
- Standard chart layout (`Chart.yaml`, `values.yaml`, `values.schema.json`, `README.md`, `LICENSE`, `crds/`, `templates/`).
- Provide `README.md` with configuration table and examples; Artifact Hub renders this content.
- Use Chart.yaml annotations for Artifact Hub metadata (`artifacthub.io/*`), including CRDs and examples.
- Provide `artifacthub-repo.yml` at the repository index level when publishing (or OCI metadata layer for OCI).

## Open Questions
- What is the minimum supported Kubernetes version for Jangar? (needed for `kubeVersion` in Chart.yaml)
- Do we want a separate chart for optional "extras" (HPA/PDB/NetworkPolicy) or manage these outside Helm?
- Should ImplementationSpec be namespaced or cluster-scoped? (default to namespaced for multi-tenant clusters)

## Appendix: Example CRD Usage (Conceptual)
Agent:
```
apiVersion: agents.proompteng.ai/v1alpha1
kind: Agent
metadata:
  name: codex-agent
spec:
  providerRef:
    name: codex-runner
  runtime:
    type: custom
  memoryRef:
    name: default-memory
  resources:
    cpu: 1
    memory: 2Gi
```

ImplementationSpec:
```
apiVersion: agents.proompteng.ai/v1alpha1
kind: ImplementationSpec
metadata:
  name: impl-1234
spec:
  source:
    provider: github
    externalId: proompteng/lab#1234
    url: https://github.com/proompteng/lab/issues/1234
  text: "Implement agent helm chart redesign."
  summary: "Implement agent helm chart redesign"
  acceptanceCriteria:
    - "Chart installs on minikube and kind"
    - "No ingress in base chart"
```

AgentRun:
```
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  generateName: codex-run-
spec:
  agentRef:
    name: codex-agent
  implementationRef:
    name: impl-1234
  execution:
    coordinates:
      git:
        url: https://github.com/proompteng/lab.git
        ref: main
        path: .
  workload:
    image: ghcr.io/proompteng/codex-agent:latest
    resources:
      cpu: 2
      memory: 4Gi
```
