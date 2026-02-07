# Dynamically Reloaded Settings via Kubernetes ConfigMaps

Status: Draft (2026-02-07)

## Current State

- Controllers (agents/orchestration/supporting) are configured primarily via environment variables rendered by the Agents Helm chart:
  - Control plane: `charts/agents/templates/deployment.yaml`
  - Controllers: `charts/agents/templates/deployment-controllers.yaml`
- Per-run payloads are delivered to runner Jobs via generated ConfigMaps:
  - `services/jangar/src/server/agents-controller.ts` (`createRunSpecConfigMap`, `createInputFilesConfigMap`)
- Jangar already has a `kubectl`-based watch abstraction used by controllers:
  - `services/jangar/src/server/kube-watch.ts` (`startResourceWatch`)
- There is no general-purpose “settings store” with runtime reload semantics; changing controller knobs typically requires a pod restart.

## Problem

- Many knobs are operational in nature (concurrency, rate limits, queue sizes, retry/backoff, feature flags).
- Treating every knob change as a deployment rollout is slow and raises blast radius.
- Kubernetes Job retries can replay side-effecting AgentRuns (e.g. PR creation) when the runner exits non-zero.

## Goals

- Add a dynamically reloaded settings layer sourced from a Kubernetes ConfigMap.
- Keep backwards compatibility with existing env var configuration.
- Provide safe parsing + validation and last-known-good behavior.
- Make changes observable (logs + metrics) and easy to roll back.
- Keep scope minimal and enable incremental adoption (migrate high-value knobs first).

## Non-Goals

- Dynamic secret reloading (continue using Secrets; restart is fine).
- A full “config CRD” system.
- Immediate consistency; eventual propagation is acceptable.
- Replacing per-run overrides (`AgentRun.spec.runtime.config`) which should remain the highest-precedence per-run control.

## Design

### Settings Precedence

Define settings precedence (highest to lowest):

1. Per-object runtime overrides (e.g. `AgentRun.spec.runtime.config`).
2. Dynamic ConfigMap settings (new).
3. Process environment (`process.env`).
4. Hard-coded defaults.

This matches existing behavior but inserts a live-tunable middle layer.

### ConfigMap Format

Create a well-known, namespaced ConfigMap (default name `jangar-settings`) with a single YAML settings document stored under `data.settings` (as a string).

Kubernetes ConfigMaps require `data` values to be strings (`map[string]string`), so we cannot put nested objects directly under `data`. Attempting to do so fails with:

- `json: cannot unmarshal object into Go struct field ConfigMap.data of type string`

The YAML document MUST use lowercase keys and MUST include a top-level `control_plane` map (even if empty). All other keys are optional.

Rationale:

- Avoid env-var style `ALLCAPS` keys in the ConfigMap.
- Make room for structured settings (nested maps) while still fitting the ConfigMap schema.
- Keep a clean separation between:
  - process bootstrap (still `process.env`, used for things like “which ConfigMap should I watch?”), and
  - runtime-tunable knobs (the dynamic settings document).

Example:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: jangar-settings
  namespace: agents
data:
  settings: |
    control_plane:
      cache:
        enabled: true
      agent_runner:
        backoff_limit: 0
        job_ttl_seconds: 600
        log_retention_seconds: 604800
      agents_controller:
        concurrency:
          namespace: 10
          agent: 5
          cluster: 100
        queue:
          namespace: 200
          repo: 50
          cluster: 1000
        rate:
          window_seconds: 60
          namespace: 120
          repo: 30
          cluster: 600
        repo_concurrency:
          enabled: false
          default: null
          overrides:
            proompteng/lab: 2
```

### Reload Mechanism

Reuse the existing `kubectl` watch machinery:

- Watch `configmaps` in the pod namespace with `--field-selector metadata.name=<name>`.
- Parse `ADDED`/`MODIFIED` events and rebuild the in-memory settings map from `object.data.settings`.
- On watch failures, reuse `startResourceWatch`’s restart logic.

This avoids implementing Kubernetes API clients and aligns with how controllers already watch CRs.

Implementation detail:

- Introduce `DynamicSettingsManager` (new module) that owns:
  - The current settings map.
  - The last observed `resourceVersion`.
  - The last good snapshot timestamp and last error.
  - An optional subscriber list for push updates.
- The manager should treat invalid values as “ignored” (do not crash controllers). If parsing fails at the “whole config” level (e.g. non-string `data`), keep last-known-good and surface error.
- Parse/validate pipeline:
  - Read `object.data.settings` as a string.
  - Parse YAML -> `unknown` (recommend `yaml` npm package, already used in `services/jangar/agentctl`).
  - Validate -> typed settings object (recommend `@effect/schema` for a partial schema with defaults).
  - Apply -> swap the snapshot atomically if validation succeeds; otherwise retain last-known-good.

### Opt-In and Compatibility

Add a small set of env vars for the controller process:

- `JANGAR_DYNAMIC_SETTINGS_ENABLED` (`"true"`/`"false"`, default `"false"` initially).
- `JANGAR_DYNAMIC_SETTINGS_CONFIGMAP_NAME` (default `"jangar-settings"`).
- `JANGAR_DYNAMIC_SETTINGS_NAMESPACE` (default `JANGAR_POD_NAMESPACE`).

When disabled, the manager is a no-op and all reads fall back to `process.env` + defaults.

### Consumption API

Expose a helper used across server modules that reads from:

1. per-run overrides (call site), then
2. dynamic ConfigMap data (new), then
3. `process.env` (bootstrap/static), then
4. defaults.

Recommended API shape:

- `readSetting(path: readonly string[]): unknown` where `path` uses lowercase segments (e.g. `['control_plane', 'agent_runner', 'backoff_limit']`).
- Type helpers:
  - `readSettingBool(path, defaultValue): boolean`
  - `readSettingNumber(path, defaultValue, { min, max }): number`
  - `readSettingString(path, defaultValue): string`
  - `readSettingRecord(path, defaultValue): Record<string, unknown>`

Backwards compatibility approach:

- Keep existing env parsing helpers, but refactor them to accept a `(envKey: string) => string | undefined` getter.
- Implement a small mapping table `envKey -> path` so legacy code paths can continue to use env-style keys while the dynamic document remains structured and lowercase.

Example mapping entries:

- `JANGAR_AGENT_RUNNER_BACKOFF_LIMIT` -> `['control_plane', 'agent_runner', 'backoff_limit']`
- `JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS` -> `['control_plane', 'agent_runner', 'job_ttl_seconds']`
- `JANGAR_AGENT_RUNNER_LOG_RETENTION_SECONDS` -> `['control_plane', 'agent_runner', 'log_retention_seconds']`
- `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_NAMESPACE` -> `['control_plane', 'agents_controller', 'concurrency', 'namespace']`
- `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_AGENT` -> `['control_plane', 'agents_controller', 'concurrency', 'agent']`
- `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_CLUSTER` -> `['control_plane', 'agents_controller', 'concurrency', 'cluster']`

### Initial Adoption Targets

Migrate the knobs that are high value and/or safety critical:

- Job retry behavior for runner Jobs:
  - `['control_plane', 'agent_runner', 'backoff_limit']` (default `0` to avoid replaying side effects).
- Controller concurrency/queue/rate:
  - `['control_plane', 'agents_controller', 'concurrency', '*']`
  - `['control_plane', 'agents_controller', 'queue', '*']`
  - `['control_plane', 'agents_controller', 'rate', '*']`
- Webhook ingestion tuning:
  - `['control_plane', 'agents_controller', 'webhooks', 'queue_size']`
  - `['control_plane', 'agents_controller', 'webhooks', 'retry', '*']`

### Observability

Add:

- Structured logs on settings reload success/failure (include configmap name/namespace and resourceVersion).
- Prometheus metrics (in `services/jangar/src/server/metrics.ts`):
  - `jangar_dynamic_settings_reload_success_total`
  - `jangar_dynamic_settings_reload_failure_total`
  - `jangar_dynamic_settings_last_reload_timestamp_seconds`
  - `jangar_dynamic_settings_resource_version` (string-as-label, or hash-as-gauge)

Optional:

- Expose the current snapshot in the control-plane status surface (`services/jangar/src/server/control-plane-status.ts`) and/or a `/api/...` endpoint.

## Chart Changes

Add an optional settings ConfigMap to the chart plus values/schema for it.

The chart should render ConfigMap `data.settings` from values in a way that guarantees:

- lowercase keys (chart values should already be lowercase/snake_case for dynamic settings)
- stable, predictable YAML output (so Git diffs are readable)

- New template: `charts/agents/templates/configmap-dynamic-settings.yaml`
- New values:
  - `dynamicSettings.enabled` (default `false`)
  - `dynamicSettings.name` (default `jangar-settings`)
  - `dynamicSettings.settings` (object; rendered to YAML under `data.settings`)
  - `dynamicSettings.namespace` (default release namespace)
- Wire env vars into both deployments when enabled:
  - `JANGAR_DYNAMIC_SETTINGS_ENABLED=true`
  - `JANGAR_DYNAMIC_SETTINGS_CONFIGMAP_NAME=<name>`
  - `JANGAR_DYNAMIC_SETTINGS_NAMESPACE=<namespace>`

## Operational Considerations

- GitOps remains the source of truth. Operators update the ConfigMap via Argo CD like any other resource.
- Rollbacks are a simple revert of the ConfigMap data in Git and sync.
- Because the config is human-authored, validation + clear error messages are critical to prevent silent misconfig.

## Implementation Plan

1. Foundation (code only, disabled by default)
   - Add `DynamicSettingsManager` + read helpers.
   - Add metrics + logs.
   - Add unit tests for reload and precedence.
2. Adopt high-value knobs
   - Update `services/jangar/src/server/agents-controller.ts` to source runner Job defaults via settings helper (keep `AgentRun.spec.runtime.config` highest precedence).
   - Update webhook tuning in `services/jangar/src/server/implementation-source-webhooks.ts`.
   - Update any “controller knobs” that are currently parsed once at startup (ensure re-reads happen per reconcile tick or on update).
3. Chart plumbing
   - Add chart template + values/schema.
   - Keep `dynamicSettings.enabled: false` by default; add docs and examples.
4. Rollout
   - Enable in a non-prod/CI namespace first.
   - Observe metrics/logs; confirm setting changes take effect without restarting controllers.
   - Enable in prod and document the runbook.

## Risks and Mitigations

- Bad config causes controller regressions:
  - Mitigate with strict parsing, last-known-good snapshots, and visible errors/metrics.
- Multiple replicas cause load or inconsistent timing:
  - Mitigate with watch (preferred) and/or jittered polling fallback.
- Confusing precedence between env and ConfigMap:
  - Mitigate by documenting precedence and providing a “effective settings” debug endpoint.

## Validation

- Unit: simulate watch events; ensure snapshot updates and invalid events are rejected safely.
- In-cluster:
  - Apply a ConfigMap update and confirm logs show reload.
  - Submit a new AgentRun and confirm the resulting runner Job spec reflects updated defaults (e.g. `backoffLimit`).

## Acceptance Criteria

- Updating the settings ConfigMap changes effective controller behavior without restarting pods.
- Invalid updates do not crash controllers and do not replace last-known-good settings.
- Operators can observe reload status via logs and metrics.

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Helm chart: `charts/agents` (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, `crds/`)
- GitOps application (desired state): `argocd/applications/agents/application.yaml`, `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
- Control plane + controllers code:
  - `kubectl` watch abstraction: `services/jangar/src/server/kube-watch.ts`
  - Agents/AgentRuns controller: `services/jangar/src/server/agents-controller.ts`
  - Orchestrations: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks (budgets/approval/etc): `services/jangar/src/server/primitives-policy.ts`
- API endpoints that surface controller health/state:
  - `/health`: `services/jangar/src/routes/health.tsx`
  - Control-plane status surface: `services/jangar/src/server/control-plane-status.ts`

### Current cluster state (GitOps desired + live API server)
As of 2026-02-07 (repo `main`):
- Kubernetes API server (live): `v1.35.0+k3s1` (from `kubectl get --raw /version`).
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps (see `argocd/applications/agents/values.yaml`):
  - Control plane (`Deployment/agents`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5436c9d2@sha256:b511d73a2622ea3a4f81f5507899bca1970a0e7b6a9742b42568362f1d682b9a`
  - Controllers (`Deployment/agents-controllers`): `registry.ide-newton.ts.net/lab/jangar:5436c9d2@sha256:d673055eb54af663963dedfee69e63de46059254b830eca2a52e97e641f00349`
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Runner auth (GitHub token): `envFromSecretRefs: [agents-github-token-env]`. See `argocd/applications/agents/values.yaml`.

To verify live cluster state (requires sufficient RBAC), run:

```bash
kubectl get --raw /version

kubectl -n agents get deploy
kubectl -n agents get pods

kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Rollout plan (GitOps)

1. Add the ConfigMap template + values/schema to `charts/agents`.
2. Update the GitOps overlay to enable it:
   - `argocd/applications/agents/values.yaml`
3. Validate rendering and manifests:

```bash
mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml
./scripts/agents/validate-agents.sh
./scripts/argo-lint.sh
./scripts/kubeconform.sh argocd
```
