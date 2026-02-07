# Custom System Prompt for Agent Runs

Status: Implemented (2026-02-07)

Note: Clusters will accept/run the new fields once the updated `charts/agents` CRDs and the relevant controller/runtime deployments (plus Argo templates, if used) are rolled out.

## Summary
Agent runs now support per-run system prompts with Agent-level defaults. Prompts can be provided inline or by reference (Secret/ConfigMap). Codex runs apply the resolved prompt and record a SHA-256 hash for audit without logging prompt contents.

## Goals (Shipped)
- Per-run custom system prompt for AgentRun executions, with optional defaults at Agent level.
- Prompts can be supplied inline or by reference (ConfigMap/Secret).
- Codex job/workflow runs apply the system prompt without breaking existing runs.
- Auditability via hashes/metadata without leaking prompt contents.

## Non-Goals
- Redesigning the Codex user prompt builder or issue ingestion flows.
- Providing a UI for system prompt management in this phase.
- Expanding behavior for non-Codex providers beyond pass-through availability.

## Current State (Implemented)
- CRDs add `systemPrompt` / `systemPromptRef` on `AgentRun.spec` and `Agent.spec.defaults`, plus `status.systemPromptHash` on `AgentRun`. See `services/jangar/api/agents/v1alpha1/types.go` and `charts/agents/crds/`.
- Jangar resolves a system prompt using precedence rules, applies security checks, and records a SHA-256 hash in `AgentRun.status`. See `services/jangar/src/server/agents-controller.ts`.
- `codex-implement` resolves system prompt from `CODEX_SYSTEM_PROMPT_PATH` (preferred) or the event payload, logs only hash/length, and passes it to Codex. See `services/jangar/scripts/codex/codex-implement.ts`.
- `CodexRunner` forwards the system prompt as `--config developer_instructions=<toml-string>` when non-empty. See `packages/codex/src/runner.ts`.
- Argo templates accept inline + Secret/ConfigMap system prompt inputs and set `CODEX_SYSTEM_PROMPT_PATH` when a ref is supplied. See `argocd/applications/froussard/*workflow-template*.yaml`.

## API Additions
Optional system prompt fields are available on AgentRun and Agent defaults:

```yaml
spec:
  systemPrompt: string
  systemPromptRef:
    kind: Secret|ConfigMap
    name: string
    key: string
```

Agent defaults:

```yaml
spec:
  defaults:
    systemPrompt: string
    systemPromptRef:
      kind: Secret|ConfigMap
      name: string
      key: string
```

Validation:
- `systemPrompt` maxLength: 16384 (CRD + controller enforcement).
- `systemPrompt` and `systemPromptRef` are mutually exclusive at each level (XValidation).
- `systemPromptRef` must reference a Secret or ConfigMap in the same namespace.
- `systemPrompt` is treated as non-secret; sensitive content should use `systemPromptRef`.

## Resolution Order
1. `AgentRun.spec.systemPromptRef`
2. `AgentRun.spec.systemPrompt`
3. `Agent.spec.defaults.systemPromptRef`
4. `Agent.spec.defaults.systemPrompt`
5. No system prompt override

Notes:
- Empty/blank inline strings are treated as unset and fall through to the next candidate.
- `systemPromptRef` resolution short-circuits the search even if inline fields exist elsewhere.

## Controller Behavior (Jangar)
- Resolves system prompt per the precedence above.
- Inline prompt: included in the run payload (`systemPrompt` in event JSON).
- Ref prompt: mounted into the runtime pod as `/workspace/.codex/system-prompt.txt`, and `CODEX_SYSTEM_PROMPT_PATH` is set.
- Ref prompt: the prompt contents are not injected into the run payload.
- Records `systemPromptHash` (SHA-256 hex of prompt contents) in `AgentRun.status`.

Security constraints:
- Secret references must be present in `AgentRun.spec.secrets`.
- If `Agent.spec.security.allowedSecrets` is non-empty, Secret references must be allowlisted there.
- Secret references must not match `JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS` (exact matching, consistent with other secret mounts).
- ConfigMap references do not require allowlisting.
- Secret data is read from `stringData` first, then base64-decoded from `data`.
- Missing refs/keys or invalid types fail the run with `InvalidSpec`.

## Runtime Behavior (Codex)
- `codex-implement` prefers `CODEX_SYSTEM_PROMPT_PATH` when the file exists and is non-empty; otherwise it falls back to `event.systemPrompt`.
- The resolved system prompt is passed to `CodexRunner` as `--config developer_instructions=<toml-string>`.
- Prompt contents are never logged; only hash and length are logged. A `systemPromptHash` attribute is attached to the NATS `run-started` event.
- `developer_instructions` is encoded as a quoted TOML string literal (do not attempt manual shell-escaping).

## Workflow Template Behavior (Argo)
- `codex-run`, `codex-autonomous`, and `github-codex-implementation` templates accept `system_prompt`.
- `codex-run`, `codex-autonomous`, and `github-codex-implementation` templates accept `system_prompt_secret_name` and `system_prompt_secret_key`.
- `codex-run`, `codex-autonomous`, and `github-codex-implementation` templates accept `system_prompt_configmap_name` and `system_prompt_configmap_key`.
- Secret mounts are exposed at `/workspace/.codex/system-prompt/secret/<key>`.
- ConfigMap mounts are exposed at `/workspace/.codex/system-prompt/configmap/<key>`.
- The template copies the selected file to `/workspace/.codex/system-prompt.txt` and sets `CODEX_SYSTEM_PROMPT_PATH`.
- The inline `system_prompt` is injected into the event JSON when non-empty.

Argo examples:

```bash
argo submit \
  --from workflowtemplate/codex-run \
  -n jangar \
  -p repository='proompteng/lab' \
  -p issue_number='1234' \
  -p head='my-branch' \
  -p prompt='Implement X' \
  -p system_prompt='You are a strict reviewer. Prefer minimal diffs.'
```

```bash
argo submit \
  --from workflowtemplate/codex-run \
  -n jangar \
  -p repository='proompteng/lab' \
  -p issue_number='1234' \
  -p head='my-branch' \
  -p prompt='Implement X' \
  -p system_prompt_secret_name='my-system-prompt' \
  -p system_prompt_secret_key='system-prompt.txt'
```

## Provider Pass-Through
- `systemPrompt` is present in the run payload for inline prompts, allowing non-Codex providers to consume it if desired.

## Data Flow (Codex, Inline Prompt)
1. AgentRun created with `spec.systemPrompt`.
2. Jangar resolves the system prompt and adds it to the event payload.
3. `agent-runner` writes event JSON to disk.
4. `codex-implement` reads event JSON and extracts `systemPrompt`.
5. `CodexRunner` invokes `codex exec --config developer_instructions="<prompt>"`.

## Data Flow (Codex, Ref Prompt)
1. AgentRun created with `spec.systemPromptRef`.
2. Jangar mounts the Secret/ConfigMap into `/workspace/.codex/system-prompt.txt` and exports `CODEX_SYSTEM_PROMPT_PATH`.
3. `codex-implement` reads `CODEX_SYSTEM_PROMPT_PATH` (preferred) and resolves the prompt.
4. `CodexRunner` invokes `codex exec --config developer_instructions="<prompt>"`.

## Hashing and Audit
- `AgentRun.status.systemPromptHash` stores the SHA-256 hex of the resolved prompt.
- `codex-implement` computes the hash of the resolved prompt and attaches it to the NATS `run-started` event.
- Prompt contents are never emitted to logs.
- Hash drift: if a Secret/ConfigMap changes mid-run, the controller-computed hash (recorded in `AgentRun.status`) and the runtime-computed hash (attached to NATS) can differ.

## Limitations
- Temporal runtime only receives inline `systemPrompt` in the payload. `systemPromptRef` is not mounted and is ignored for temporal runs.
- Custom runtime uses `spec.runtime.config.payload` (if set) else `{agentRun, implementation, memory}`. It does not receive the resolved system prompt (after applying Agent defaults or reading refs) unless you include it explicitly.
- No per-workflow-step system prompt overrides; workflow steps all share the resolved prompt.
- `systemPrompt` is not injected into any additional contract metadata beyond the event payload and `systemPromptHash` status field.

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth (repo)
- Helm chart: `charts/agents` (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, `crds/`)
- GitOps application (desired state): `argocd/applications/agents/application.yaml`, `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
- Runner RBAC for CI (desired state): `argocd/applications/agents-ci/`
- Product appset enablement: `argocd/applicationsets/product.yaml`
- CRD Go types and codegen:
  - Go types: `services/jangar/api/agents/v1alpha1/types.go`
  - Validation + drift checks: `scripts/agents/validate-agents.sh`
- Controllers (primary code pointers):
  - Agents/AgentRuns reconcile loop: `services/jangar/src/server/agents-controller.ts`
  - Supporting primitives (budgets/approval/tools/etc): `services/jangar/src/server/supporting-primitives-controller.ts`
  - Orchestrations: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Policy logic (budgets/approval/etc): `services/jangar/src/server/primitives-policy.ts`
  - kubectl integration: `services/jangar/src/server/primitives-kube.ts`, `services/jangar/src/server/kube-watch.ts`
- Codex runners (when applicable): `services/jangar/scripts/codex/codex-implement.ts`, `packages/codex/src/runner.ts`
- Argo WorkflowTemplates used by Codex (when applicable): `argocd/applications/froussard/*.yaml` (notably WorkflowTemplates in namespace `jangar`)

### Desired cluster state (GitOps)
As of 2026-02-07 (repo `main`):
- Namespace: `agents` (`argocd/applications/agents/kustomization.yaml`)
- Argo CD app: `agents` (`argocd/applications/agents/application.yaml`) with automated sync + Server Side Apply
- Helm release: `agents` installs chart `charts/agents` version `0.9.1` with `includeCRDs: true` (`argocd/applications/agents/kustomization.yaml`)
- Images pinned by GitOps (see `argocd/applications/agents/values.yaml`):
  - Control plane (`deploy/agents`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae`
  - Controllers (`deploy/agents-controllers`): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`
- Namespaced reconciliation + RBAC:
  - `controller.namespaces: [agents]`
  - `rbac.clusterScoped: false`
- Database wiring:
  - `database.secretRef.name: jangar-db-app`
  - `database.secretRef.key: uri`
- gRPC (control plane service):
  - `grpc.enabled: true`
  - `grpc.serviceType: ClusterIP`
  - `grpc.port/servicePort: 50051`
- Bootstrap CRs/resources applied alongside the Helm release (if the Argo app is Synced):
  - `SecretBinding/codex-github-token`: `argocd/applications/agents/codex-secretbinding.yaml`
  - `AgentProvider/codex-runner`: `argocd/applications/agents/codex-agentprovider.yaml`
  - `Agent/codex`: `argocd/applications/agents/codex-agent.yaml`
  - `VersionControlProvider/github`: `argocd/applications/agents/codex-versioncontrolprovider.yaml`
  - `ConfigMap/codex-agent-system-prompt`: `argocd/applications/agents/codex-agent-system-prompt-configmap.yaml`
  - Sample policies: `argocd/applications/agents/sample-approvalpolicy.yaml`, `argocd/applications/agents/sample-budget.yaml`, `argocd/applications/agents/sample-signal.yaml`

### Live cluster verification (requires RBAC)
Treat `charts/agents/**` and `argocd/applications/**` as desired state. To confirm the *live* cluster is synced (and catch drift), run from an operator machine/service-account that can read Argo CD + the `agents` namespace:

```bash
# Argo CD sync/health
kubectl get application -n argocd agents -o wide
kubectl get application -n argocd agents -o yaml | rg -n "sync|health|targetRevision|revision"

# Control plane + controllers workload
kubectl -n agents get deploy,rs,pods,svc -o wide
kubectl -n agents rollout status deploy/agents
kubectl -n agents rollout status deploy/agents-controllers
kubectl -n agents logs deploy/agents --tail=200
kubectl -n agents logs deploy/agents-controllers --tail=200

# CRDs + bootstrap CRs
kubectl -n agents get agentproviders.agents.proompteng.ai,agents.agents.proompteng.ai,versioncontrolproviders.agents.proompteng.ai
kubectl -n agents get approvalpolicies.approvals.proompteng.ai,budgets.budgets.proompteng.ai,signals.signals.proompteng.ai

# Optional (cluster-scope): confirm CRDs installed
kubectl get crd | rg 'proompteng\.ai'
```

### Values → env var mapping (chart)
Rendered primarily by `charts/agents/templates/deployment.yaml` (control plane) and `charts/agents/templates/deployment-controllers.yaml` (controllers).

Precedence rules to remember when debugging:
- `env.vars` is the shared base env map.
- `controlPlane.env.vars` overlays `env.vars` for `deploy/agents`.
- `controllers.env.vars` overlays `env.vars` for `deploy/agents-controllers`.
- Some controller-side env vars are forced unless explicitly overridden (e.g. `JANGAR_MIGRATIONS=skip` and `JANGAR_GRPC_ENABLED=0`).

Common mappings:
- `controller.namespaces` → `JANGAR_AGENTS_CONTROLLER_NAMESPACES` and `JANGAR_PRIMITIVES_NAMESPACES`
- `controller.concurrency.*` → `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_NAMESPACE`, `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_AGENT`, `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_CLUSTER`
- `controller.queue.*` → `JANGAR_AGENTS_CONTROLLER_QUEUE_NAMESPACE`, `JANGAR_AGENTS_CONTROLLER_QUEUE_REPO`, `JANGAR_AGENTS_CONTROLLER_QUEUE_CLUSTER`
- `controller.rate.*` → `JANGAR_AGENTS_CONTROLLER_RATE_WINDOW_SECONDS`, `JANGAR_AGENTS_CONTROLLER_RATE_NAMESPACE`, `JANGAR_AGENTS_CONTROLLER_RATE_REPO`, `JANGAR_AGENTS_CONTROLLER_RATE_CLUSTER`
- `controller.agentRunRetentionSeconds` → `JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS`
- `controller.admissionPolicy.*` → `JANGAR_AGENTS_CONTROLLER_LABELS_REQUIRED|ALLOWED|DENIED`, `JANGAR_AGENTS_CONTROLLER_IMAGES_ALLOWED|DENIED`, `JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS`
- `controller.vcsProviders.*` → `JANGAR_AGENTS_CONTROLLER_VCS_PROVIDERS_ENABLED` (+ related VCS policy env vars)
- `controller.authSecret.*` → `JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME|KEY|MOUNT_PATH`
- `orchestrationController.*` → `JANGAR_ORCHESTRATION_CONTROLLER_ENABLED|NAMESPACES`
- `supportingController.*` → `JANGAR_SUPPORTING_CONTROLLER_ENABLED|NAMESPACES`
- `grpc.*` → `JANGAR_GRPC_ENABLED|HOST|PORT` (unless overridden via `env.vars`)
- `controller.jobTtlSecondsAfterFinished` → `JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS`
- `runtime.*` → `JANGAR_AGENT_RUNNER_IMAGE`, `JANGAR_AGENT_IMAGE`, `JANGAR_SCHEDULE_RUNNER_IMAGE`, `JANGAR_SCHEDULE_SERVICE_ACCOUNT` (unless overridden via `env.vars`)

### Rollout plan (GitOps)
1. Update code + chart + CRDs in one PR when changing APIs:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally (fast, deterministic):
   - `scripts/agents/validate-agents.sh`
   - `scripts/argo-lint.sh`
   - `scripts/kubeconform.sh argocd`
   - Render the full install: `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
3. Update GitOps values when behavior/config changes require it:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

Rollback (GitOps):
- Revert the PR (or pin the chart/image back) and let Argo CD self-heal.

### Validation (smoke)
- Schema + examples (local): `scripts/agents/validate-agents.sh`
- Render (local): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- In-cluster (operator RBAC required):
  - `kubectl -n agents get pods`
  - `kubectl -n agents logs deploy/agents-controllers --tail=200`
  - Apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
