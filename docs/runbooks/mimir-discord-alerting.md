# Production Design: Mimir → Discord Alerting via Argo CD

Status: Proposed (2026-02-28)

## Summary

Create a production-grade, environment-driven alerting pipeline that routes alerts created by Mimir rule groups in the `argocd/applications/observability/` stack to Discord, with all traffic, secrets, and rollout behavior managed through Argo CD.

This design is intentionally **generic to Mimir** and is not coupled to any specific Grafana UI feature.

## Decision & Scope

- **Source**: Mimir ruler + Mimir Alertmanager in `observability-mimir`.
- **Sink**: Discord incoming webhook via an in-cluster relay endpoint.
- **Deployment model**: All configuration via GitOps (`argocd/applications/observability/`).
- **Routing scope**: Only alerts explicitly labeled as observability-owned should be sent to Discord.
- **Out of scope**:
  - moving rules to another alerting platform,
  - multi-cluster fan-out,
  - paging/incident lifecycle in Discord itself.

## Why this is a Mimir-specific design (not Grafana-specific)

- Grafana is currently only the visualization layer in this stack.
- Alert generation and notification routing are owned by:
  - `argocd/applications/observability/graf-mimir-rules.yaml` (PrometheusRule config for Mimir).
  - `argocd/applications/observability/mimir-values.yaml` (Alertmanager/route config).
- Therefore Discord notifications are designed off the Mimir Alertmanager contract, not Grafana notification channels.

## Current observed state (verified)

- `argocd app get observability` shows `observability` is `Synced` and `Healthy` under Argo CD application set.
- Running Alertmanager workload:
  - `observability-mimir-alertmanager` is a `StatefulSet` with 1 replica.
  - StatefulSet currently has no Discord-specific env vars.
- Existing config map:
  - `observability-mimir-alertmanager-fallback-config` only contains defaults and `default-receiver`.
- `observability` namespace has `rook-ceph-rgw-loki` and `observability-grafana` secrets, but no Discord alert secret yet.
- Public route exists:
  - `observability-mimir-tailscale` routes to `observability-mimir-nginx` with `/alertmanager` path.
- Mimir Helm chart values currently match expected env injection shape: `alertmanager.env` and `alertmanager.extraEnvFrom` are available, **not** `alertmanager.extraEnv`.

## Requirements

- Non-negotiable
  - Keep notification credentials out of Git history.
  - Preserve alerting for all existing receivers while adding Discord as an additive path.
  - Maintain deterministic behavior under reconciliation (`helm` templating, checksum-driven rollout).
  - Support both warning and critical flows with separate repeat behavior.

- Recommended
  - Route only explicit observability-owned alerts.
  - Keep payload transformation isolated in a small relay for long-term compatibility.
  - Provide clear rollback path to a default-only Alertmanager configuration.

## High-level architecture

```mermaid
flowchart LR
  A[PrometheusRule resources in observability app] -->|rule labels| B[Mimir Ruler]
  B -->|alerts| C[Mimir Alertmanager StatefulSet]
  C -->|route/group/group intervals| D[alertmanager.fallbackConfig]
  D -->|HTTP POST| E[Discord relay (internal namespace service)]
  E -->|validated payload| F[Discord incoming webhook endpoint]
  C -->|no match / disabled route| G[default-receiver/no-op]
```

## Target alert model

1. Labeling contract
   - Every alert expected to be shipped to Discord must include:
     - `team: observability`
     - `platform: mimir`
   - This can be expanded later to a shared label such as `alert_scope` if cross-domain traffic increases.

2. Route contract
   - All alerts with `team=observability` go through the Discord path.
   - Severity buckets are separated for fan-out behavior:
     - `critical`: immediate notify and faster repeats.
     - `warning/info`: slower repeat cadence to reduce noise.
   - All unresolved and resolved states are posted, with resolved defaulted on for operational confidence.

## Proposed Argo CD/GitOps changes

### 1) Mimir Alertmanager config

File: `argocd/applications/observability/mimir-values.yaml`

```yaml
alertmanager:
  env:
    - name: OBS_DISCORD_RELAY_URL
      valueFrom:
        secretKeyRef:
          name: observability-mimir-discord
          key: relayUrl
  fallbackConfig: |
    global:
      resolve_timeout: 5m
    route:
      receiver: observability-default
      group_by: [alertname, namespace, team, severity]
      group_wait: 45s
      group_interval: 5m
      repeat_interval: 4h
      routes:
        - receiver: observability-discord-crit
          group_wait: 10s
          repeat_interval: 45m
          group_interval: 2m
          matchers:
            - team = "observability"
            - severity = "critical"
          continue: false
        - receiver: observability-discord-warn
          group_wait: 45s
          repeat_interval: 3h
          group_interval: 10m
          matchers:
            - team = "observability"
            - severity = "warning"
          continue: false
        - receiver: observability-default
          matchers:
            - team = "observability"
    receivers:
      - name: observability-default
      - name: observability-discord-crit
        webhook_configs:
          - url: ${OBS_DISCORD_RELAY_URL}
            send_resolved: true
            max_alerts: 100
      - name: observability-discord-warn
        webhook_configs:
          - url: ${OBS_DISCORD_RELAY_URL}
            send_resolved: false
            max_alerts: 100
```

Notes:
- Keep default receiver non-empty because Alertmanager requires a fallback receiver.
- Use `${OBS_DISCORD_RELAY_URL}` (env expansion is already enabled for this chart, verified by runtime container args).
- If in future we choose to hit Discord directly, replace the relay URL with a direct Discord webhook URL and remove relay-specific assumptions.

### 2) Rule labeling strategy

File: `argocd/applications/observability/graf-mimir-rules.yaml`

- Add labels in each Mimir-owned alert rule that should route to Discord, for example:
  - `team: observability`
  - `platform: mimir`
- Keep this explicit even in existing rules so routing remains deterministic.
- Example label addition:
  - `labels: { severity: warning, team: observability, platform: mimir }`

### 3) Secret and optional relay wiring

#### Option A (recommended for production start)

1. Add `argocd/applications/observability/observability-mimir-discord-sealedsecret.yaml`:
   - Secret name: `observability-mimir-discord`
   - Sealed key: `relayUrl`

2. Add relay resource manifests to `argocd/applications/observability/kustomization.yaml`.
3. Add a dedicated in-namespace relay deployment + service.

Relay contract (minimum production requirements):
- Accept POST from Alertmanager webhook format.
- Convert payload to Discord embed/message format.
- Return HTTP 200 only when posted successfully to Discord.
- Emit observability metrics (`discord_relay_requests_total`, `discord_relay_http_errors_total`, `discord_relay_latency_seconds`).
- Include request timeout and retry-safe behavior.

#### Option B (evaluation path)

If `discord_configs` is confirmed supported by the pinned Mimir Alertmanager image/version in future, eliminate relay dependency and switch receivers to direct Discord webhook configs.

### 4) Argo CD patching safety

- Only the values file and new secrets/resources change; component chart versions stay unchanged.
- Use existing checksum-based rollout behavior from Helm template rendering.

## Reliability and security design

- **Secret isolation**
  - Secret never stored plain in values files.
  - Use SealedSecret pattern, same as `rook-ceph-rgw-loki`.
- **Blast radius control**
  - Only `team=observability` alerts are routed to Discord.
  - Receiver defaults and labels remain intact for non-target traffic.
- **Resilience**
  - Relay should be stateless and horizontally scale to 2+ replicas if sustained volume grows.
  - Configure backoff in relay; do not rely on `max_alerts: 0` unless testing.
- **Observability**
  - Track `observability` namespace pod/container logs and metrics around relay and Alertmanager config reloads.

## Deployment plan

1. Label migration
   - Edit `graf-mimir-rules.yaml` to include `team`/`platform` labels in all intended rules.
2. Add relay secret
   - Add SealedSecret manifest and include in `kustomization.yaml`.
3. Configure Alertmanager route
   - Add `alertmanager.env` and `alertmanager.fallbackConfig` in `mimir-values.yaml`.
4. Deploy relay (if used)
   - Add deployment/service manifest pair and include in `kustomization.yaml`.
5. Reconcile
   - `argocd app sync observability`
6. Validate
   - Confirm config render/update and pod rollout.
   - Trigger one synthetic alert and confirm Discord delivery.

## Verification matrix

- Kubernetes config correctness
  - `kubectl -n observability get configmap observability-mimir-alertmanager-fallback-config -o yaml`
  - `kubectl -n observability describe statefulset observability-mimir-alertmanager | sed -n '1,220p'`
- Runtime routing
  - Alertmanager logs include receiver selection lines for `observability-discord-*`.
  - Relay logs include parsed payload and HTTP status for Discord upstream.
- Functional outcome
  - At least one `team=observability` alert posts to Discord.
  - Non-target alerts retain pre-existing behavior.

## Rollback plan

1. Remove or rollback `graf-mimir-rules.yaml` label additions.
2. Remove/disable Discord receivers in `fallbackConfig`.
3. Remove `observability-mimir-discord` secret and relay resources.
4. Sync Argo CD and validate:
   - `observability-mimir-alertmanager-fallback-config` reverts to default receiver only.
   - `observability-mimir-alertmanager` pod is restarted and stable.

## Acceptance criteria

- [ ] Only labels matching `team=observability` generate Discord posts.
- [ ] Critical alerts are sent faster than warning alerts.
- [ ] No plain-text webhook secret exists in Git.
- [ ] Route changes are idempotently controlled by Argo CD only.
- [ ] Alertmanager rollout and relay startup are repeatable with no manual edits in the cluster.

## Open decisions

1. Should `resolved` notifications be sent for warnings, or only for criticals?
2. Do we need a separate severity override route for business-hours vs. after-hours routing?
3. Which relay implementation should be standardized for this org (homegrown service in this repo or pre-existing shared component)?
