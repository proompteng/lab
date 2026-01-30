# Agents Helm Chart: Five Production Features for AgentRun Execution

Status: Draft (2026-01-30)

## Purpose
Define five production-grade features to harden AgentRun execution for `charts/agents`. Each feature specifies scope, required values schema additions, Helm templates/configuration, security/observability considerations, and rollout/testing guidance.

## Design Goals
- Keep AgentRun execution predictable, repeatable, and secure across namespaces.
- Expose configuration via Helm values with validated schemas.
- Keep runtime logic in Jangar while using Helm to provide defaults, guardrails, and supporting resources.
- Align with existing chart conventions (values files, `values.schema.json`, and templates).

## Non-Goals
- Implementing a new runtime adapter in Jangar.
- Adding non-Helm install mechanisms for CRDs.
- Defining a complete CI pipeline (see `docs/agents/ci-validation-plan.md`).

---

## Feature 1: AgentRun Runtime Profiles + Job Template Defaults

### Scope
Provide standardized, production-safe Job defaults for AgentRun execution (resources, security context, volumes, timeouts, labels) while still allowing per-run overrides. This is the primary mechanism to ensure AgentRuns are scheduled safely without requiring per-run spec plumbing.

### Values schema
Add a top-level `agentRun` block with a required `defaults` object. Example structure:

```yaml
agentRun:
  defaults:
    image:
      repository: ghcr.io/proompteng/agent-runner
      tag: "2026-01-15"
      digest: ""
      pullPolicy: IfNotPresent
      pullSecrets: []
    job:
      backoffLimit: 1
      ttlSecondsAfterFinished: 86400
      activeDeadlineSeconds: 14400
      completions: 1
      parallelism: 1
    pod:
      labels: {}
      annotations: {}
      priorityClassName: ""
      schedulerName: ""
      nodeSelector: {}
      tolerations: []
      affinity: {}
      topologySpreadConstraints: []
      securityContext: {}
    container:
      securityContext: {}
      resources:
        requests:
          cpu: "500m"
          memory: "1Gi"
        limits:
          cpu: "2"
          memory: "4Gi"
    env:
      vars: {}
      secrets: []
      config: []
```

Schema rules:
- Require `agentRun.defaults.image.repository` when `agentRun.defaults.image.digest` is empty.
- Enforce numeric bounds for `ttlSecondsAfterFinished` and `activeDeadlineSeconds`.
- Validate `job` fields to Kubernetes Job types (int or null).
- For `pod.topologySpreadConstraints`, mirror Kubernetes shape used in other charts.

### Templates
- `templates/agentrun-defaults-configmap.yaml`: render JSON for defaults consumed by Jangar (mounted into the controller and referenced via env like `JANGAR_AGENTRUN_DEFAULTS_PATH`).
- `templates/deployment.yaml`: mount the defaults configmap and pass env var for location.
- Optional: `templates/agentrun-defaults-secret.yaml` if defaults include sensitive data (prefer references to Secrets rather than inline values).

### Security / Observability
- Default container `securityContext` must drop all capabilities and enforce non-root unless explicitly overridden.
- Emit controller log lines when defaults are loaded and when a run overrides defaults (with redacted fields).
- Add a controller metric for `agent_run_defaults_applied_total` (labels: runtime, namespace).

### Rollout / Testing
- Rollout: start with defaults that match current controller behavior to avoid regressions.
- Testing:
  - Unit tests on Jangar config parsing for defaults/overrides.
  - Helm template snapshot test for configmap rendering.
  - Integration test: apply an AgentRun without workload details, verify Job inherits defaults.

---

## Feature 2: Workspaces + Artifact Storage Binding for AgentRun

### Scope
Enable AgentRun Jobs to mount workspaces and publish artifacts in a production-friendly way. This includes optional PVC provisioning, read-only workspace modes, and artifact store credentials.

### Values schema
Introduce `agentRun.workspaces` and `agentRun.artifacts` values:

```yaml
agentRun:
  workspaces:
    enabled: true
    default:
      storageClassName: ""
      accessModes: ["ReadWriteOnce"]
      size: "10Gi"
      readOnly: false
      ttlSecondsAfterFinished: 86400
    labels: {}
    annotations: {}
  artifacts:
    enabled: true
    provider: "s3" # s3 | gcs | azure | filesystem
    s3:
      endpoint: ""
      bucket: ""
      region: ""
      secretRef:
        name: ""
        accessKeyIdKey: "accessKeyId"
        secretAccessKeyKey: "secretAccessKey"
      sse:
        enabled: false
        type: "AES256"
    filesystem:
      basePath: "/var/agents/artifacts"
```

Schema rules:
- Require `provider` when `artifacts.enabled`.
- Require `s3.bucket` and `s3.secretRef.name` when provider is `s3`.
- Enforce size format for PVCs (Kubernetes quantity).

### Templates
- `templates/agentrun-artifacts-secret.yaml`: optional Secret creation for artifact credentials when `createSecret` is needed (otherwise reference existing Secret).
- `templates/agentrun-workspace-pvc.yaml`: optional PVC templates used by the controller as a default (labels match AgentRun jobs so they can be located and garbage-collected).
- `templates/agentrun-configmap.yaml`: optional config values for artifact provider and workspace defaults.

### Security / Observability
- Secrets for artifact credentials must never be rendered in configmaps.
- PVCs labeled `agents.proompteng.ai/agent-run` for cleanup and audit.
- Emit metrics for `agent_run_artifact_upload_total` and `agent_run_workspace_provision_total`.

### Rollout / Testing
- Rollout: enable artifacts in staging only; verify bucket permissions.
- Testing:
  - Controller unit tests for artifact provider configuration validation.
  - e2e: create AgentRun with workspace, verify PVC creation and artifact upload.
  - Helm template test for PVC and Secret conditional rendering.

---

## Feature 3: Dedicated Runner Identity + Scoped RBAC

### Scope
Provide per-AgentRun or per-namespace runner identities to limit privileges for job execution. Support a default runner ServiceAccount and optional per-namespace service account mapping.

### Values schema
Expand existing `runnerServiceAccount` with AgentRun-specific controls:

```yaml
agentRun:
  serviceAccount:
    enabled: true
    name: ""
    annotations: {}
    automountToken: true
    rbac:
      create: true
      rules: []
  serviceAccountPerNamespace:
    enabled: false
    nameTemplate: "agentrun-{{ .Release.Name }}"
```

Schema rules:
- If `rbac.create` is true, `rules` must be a non-empty array.
- `nameTemplate` must be a valid DNS-1123 prefix.

### Templates
- Reuse `templates/runner-serviceaccount.yaml` and `templates/runner-rbac.yaml` with conditional rendering for AgentRun-specific settings.
- Add `templates/agentrun-rbac.yaml` for per-namespace RoleBindings when `serviceAccountPerNamespace.enabled`.
- Ensure controller sets `spec.workload.serviceAccountName` to the configured default unless overridden in the AgentRun spec.

### Security / Observability
- Limit runner permissions to only what Jobs need (Secrets, ConfigMaps, PVCs, Events).
- Add audit-friendly labels on RoleBindings: `agents.proompteng.ai/agent-runner`.
- Emit a warning event when an AgentRun overrides the default service account.

### Rollout / Testing
- Rollout: default to existing cluster permissions; enable runner SA and RBAC in non-prod first.
- Testing:
  - Unit tests to ensure default SA is applied when unspecified in AgentRun.
  - RBAC conformance tests: run with minimal permissions and verify Job can still start.

---

## Feature 4: Network + Pod Security Controls for AgentRun Jobs

### Scope
Allow operators to enforce network egress rules and pod security standards for AgentRun jobs via labels and optional NetworkPolicy templates. This ensures isolation without constraining controller pods.

### Values schema
Add AgentRun network and pod security controls:

```yaml
agentRun:
  networkPolicy:
    enabled: false
    policyTypes: ["Egress"]
    egress: []
    annotations: {}
  podSecurity:
    enforce: "baseline" # privileged | baseline | restricted
    warn: "restricted"
    audit: "restricted"
```

Schema rules:
- `policyTypes` only allow `Ingress` or `Egress`.
- `podSecurity` values must be one of Kubernetes PSA levels.

### Templates
- `templates/agentrun-networkpolicy.yaml`: targets AgentRun job pods using the label `agents.proompteng.ai/agent-run`.
- `templates/namespace.yaml`: optional PSA labels when `agentRun.podSecurity` is configured and `namespaceOverride` is used.

### Security / Observability
- Default `networkPolicy.enabled` to false to avoid breaking existing installs.
- Add `podSecurity` labels only when `podSecurityAdmission.enabled` is true in the chart.
- Emit controller events when a run is blocked by Pod Security Admission.

### Rollout / Testing
- Rollout: phase in egress policy per namespace; validate with canary AgentRuns.
- Testing:
  - Conformance test with PSA enforced: AgentRun should be rejected if it violates policy.
  - Helm lint + kubeconform on NetworkPolicy manifests.

---

## Feature 5: AgentRun Telemetry + Retention Guardrails

### Scope
Add production-grade observability (metrics, tracing, structured logs) and retention controls for AgentRun artifacts, logs, and history. This complements `controller.agentRunRetentionSeconds` with explicit chart-driven telemetry.

### Values schema
Add a telemetry block with Prometheus and OpenTelemetry configuration, plus retention options:

```yaml
agentRun:
  telemetry:
    enabled: true
    otel:
      enabled: false
      endpoint: ""
      headers: ""
      insecure: false
      sampler: "parentbased_traceidratio"
      sampleRate: 0.1
    prometheus:
      enabled: false
      serviceMonitor:
        enabled: false
        interval: "30s"
        scrapeTimeout: "10s"
        labels: {}
  retention:
    jobTtlSeconds: 86400
    artifactTtlSeconds: 2592000
    eventTtlSeconds: 2592000
```

Schema rules:
- Require `otel.endpoint` when `otel.enabled` is true.
- Validate `sampleRate` in range 0.0 to 1.0.

### Templates
- `templates/agentrun-telemetry-configmap.yaml`: provides runtime telemetry configuration to controller and (optionally) runner jobs.
- `templates/servicemonitor.yaml`: optional ServiceMonitor if Prometheus Operator is present.
- `templates/agentrun-retention-configmap.yaml`: retention settings consumed by controller.

### Security / Observability
- Do not include secrets in OTEL headers; require Secret references when needed.
- Scrub sensitive data in logs emitted from agent-runner.
- Provide metric for `agent_run_retention_purged_total` with labels for kind.

### Rollout / Testing
- Rollout: enable telemetry in staging with low sampling first.
- Testing:
  - Unit tests for retention config parsing.
  - Integration test with ServiceMonitor enabled in a Prometheus-enabled cluster.

---

## Cross-Feature Integration Notes
- All new values must be added to `values.schema.json` with type validation and default compatibility.
- New templates should follow chart naming patterns and use the `agents` standard labels.
- Jangar should treat configmaps as optional; missing config must not crash the controller.

## Open Questions
- Should artifact retention be enforced by controller only, or also via Kubernetes Jobs (for filesystem artifacts)?
- Do we need per-AgentRun network policies, or is a namespace-scoped policy sufficient?

## References
- `docs/agents/agents-helm-chart-implementation.md`
- `docs/agents/ci-validation-plan.md`
- `docs/agents/rbac-matrix.md`
- `charts/agents/values.yaml`
- `charts/agents/templates/`
