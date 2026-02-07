# Admission Control Policy for AgentRuns

Status: Current (2026-02-07)

## Purpose
Reject unsafe or invalid AgentRuns before runtime submission by enforcing controller-level policies.

## Current State

- Label policy: `JANGAR_AGENTS_CONTROLLER_LABELS_REQUIRED`, `..._ALLOWED`, `..._DENIED`.
- Image policy: `JANGAR_AGENTS_CONTROLLER_IMAGES_ALLOWED`, `..._DENIED`.
- Secret policy: `JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS`.
- Agent-level policy:
  - `Agent.spec.security.allowedSecrets` and `allowedServiceAccounts` gate secrets and service accounts used by
    AgentRuns.
  - Auth secrets configured via `controller.authSecret` must be allowlisted by the Agent.
- Enforcement lives in `services/jangar/src/server/agents-controller.ts` and sets `InvalidSpec` conditions when
  policy checks fail.
- GitOps desired state: the `agents` ArgoCD values do not set admission policy env vars, so the controller currently runs with
  permissive defaults.

## Design

- Validate AgentRun labels, workload images, and requested secrets before creating runtime Jobs.
- Surface policy failures as `InvalidSpec` conditions with clear `reason` values.
- Keep policy configuration centralized in Helm values and rendered into env vars.

## Configuration
`charts/agents/values.yaml` maps to controller env vars:
- `controller.admissionPolicy.labels.required` → `JANGAR_AGENTS_CONTROLLER_LABELS_REQUIRED`
- `controller.admissionPolicy.labels.allowed` → `JANGAR_AGENTS_CONTROLLER_LABELS_ALLOWED`
- `controller.admissionPolicy.labels.denied` → `JANGAR_AGENTS_CONTROLLER_LABELS_DENIED`
- `controller.admissionPolicy.images.allowed` → `JANGAR_AGENTS_CONTROLLER_IMAGES_ALLOWED`
- `controller.admissionPolicy.images.denied` → `JANGAR_AGENTS_CONTROLLER_IMAGES_DENIED`
- `controller.admissionPolicy.secrets.blocked` → `JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS`

## Enforcement Behavior

- Label violations return `InvalidSpec` with `MissingRequiredLabels`, `LabelNotAllowed`, or `LabelBlocked`.
- Image violations return `InvalidSpec` with `ImageNotAllowed` or `ImageBlocked`.
- Secret violations return `InvalidSpec` with `SecretNotAllowed` or `SecretBlocked`.

## Related Policy Systems

- Orchestration submissions enforce ApprovalPolicies and Budgets via
  `services/jangar/src/server/primitives-policy.ts` and `orchestration-submit.ts`.
- SecretBindings restrict which Secrets can be referenced by Agents and Orchestrations.

## Validation

- Create an AgentRun with a forbidden label or image and confirm `InvalidSpec` status.
- Create an AgentRun with a disallowed secret and confirm it is blocked.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout Plan
- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Helm chart: `charts/agents` (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, `crds/`)
- GitOps application (desired state): `argocd/applications/agents/application.yaml`, `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
- Product appset enablement: `argocd/applicationsets/product.yaml`
- CRD Go types and codegen: `services/jangar/api/agents/v1alpha1/types.go`, `scripts/agents/validate-agents.sh`
- Controllers:
  - Agents/AgentRuns: `services/jangar/src/server/agents-controller.ts`
  - Orchestrations: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks (budgets/approval/etc): `services/jangar/src/server/primitives-policy.ts`
- Codex runners (when applicable): `services/jangar/scripts/codex/codex-implement.ts`, `packages/codex/src/runner.ts`
- Argo WorkflowTemplates used by Codex (when applicable): `argocd/applications/froussard/*.yaml` (typically in namespace `jangar`)

### Current cluster state (from GitOps manifests)
As of 2026-02-07 (repo `main`):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps (from `argocd/applications/agents/values.yaml`): control plane `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` and controllers `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`.
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Runner RBAC for CI: `agents-ci` namespace resources in `argocd/applications/agents-ci/`.

Note: Treat `charts/agents/**` and `argocd/applications/**` as the desired state. To verify live cluster state, run:

```bash
kubectl get application -n argocd agents
kubectl get ns | rg '^(agents|agents-ci|jangar)\b'
kubectl get deploy -n agents
kubectl get crd | rg 'proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Values → env var mapping (chart)
Rendered primarily by `charts/agents/templates/deployment.yaml` and `charts/agents/templates/deployment-controllers.yaml`.

Common mappings:
- `controller.namespaces` → `JANGAR_AGENTS_CONTROLLER_NAMESPACES` (and also `JANGAR_PRIMITIVES_NAMESPACES`)
- `controller.concurrency.*` → `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_{NAMESPACE,AGENT,CLUSTER}`
- `controller.queue.*` → `JANGAR_AGENTS_CONTROLLER_QUEUE_{NAMESPACE,REPO,CLUSTER}`
- `controller.rate.*` → `JANGAR_AGENTS_CONTROLLER_RATE_{WINDOW_SECONDS,NAMESPACE,REPO,CLUSTER}`
- `controller.agentRunRetentionSeconds` → `JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS`
- `controller.admissionPolicy.*` → `JANGAR_AGENTS_CONTROLLER_{LABELS_REQUIRED,LABELS_ALLOWED,LABELS_DENIED,IMAGES_ALLOWED,IMAGES_DENIED,BLOCKED_SECRETS}`
- `controller.vcsProviders.*` → `JANGAR_AGENTS_CONTROLLER_VCS_{PROVIDERS_ENABLED,DEPRECATED_TOKEN_TYPES,PR_RATE_LIMITS}`
- `controller.authSecret.*` → `JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_{NAME,KEY,MOUNT_PATH}`
- `orchestrationController.*` → `JANGAR_ORCHESTRATION_CONTROLLER_{ENABLED,NAMESPACES}`
- `supportingController.*` → `JANGAR_SUPPORTING_CONTROLLER_{ENABLED,NAMESPACES}`
- `grpc.*` → `JANGAR_GRPC_{ENABLED,HOST,PORT}` (unless overridden via `env.vars`)
- `controller.jobTtlSecondsAfterFinished` → `JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS`
- `runtime.*` → `JANGAR_{AGENT_RUNNER_IMAGE,AGENT_IMAGE,SCHEDULE_RUNNER_IMAGE,SCHEDULE_SERVICE_ACCOUNT}` (unless overridden via `env.vars`)

### Rollout plan (GitOps)
1. Update code + chart + CRDs in one PR when changing APIs:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `scripts/argo-lint.sh`
   - `scripts/kubeconform.sh argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access):
  - `kubectl get pods -n agents`
  - `kubectl logs -n agents deploy/agents-controllers --tail=200`
  - Apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.

