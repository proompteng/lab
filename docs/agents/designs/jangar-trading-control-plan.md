# Jangar Trading Control Plan

Status: Proposed (2026-02-12)

Docs index: [README](../README.md)

## Objective

Define a control plan for Jangar that makes system performance visible and governable while Torghut adopts richer
market-intelligence context and a staged LEAN execution integration.

Detailed near-real-time quant metrics design:

- `docs/agents/designs/jangar-quant-performance-control-plane.md`

Fast evidence collection workflow:

- `docs/agents/designs/jangar-torghut-live-analysis-playbook.md`

## Scope

- Jangar control-plane observability and health controls.
- Torghut integration health signals required by Jangar operators.
- Rollout/rollback controls for LEAN-related execution changes.

Non-goals:

- Replacing Torghut deterministic risk/firewall with LLM or LEAN logic.
- Immediate production cutover to LEAN live execution.

## Current State (Live Snapshot, 2026-02-12 UTC)

### Cluster/runtime facts observed

- Deployments:
  - `deployment/agents` (control plane): `1/1` ready.
  - `deployment/agents-controllers`: `2/2` ready.
  - `deployment/jangar`: `1/1` ready.
  - `ksvc/torghut`: latest ready revision `torghut-00062`.
- Control-plane status endpoint snapshot (`2026-02-12 06:35 UTC`) reported healthy controllers and runtime adapters.
- Metrics surface gap:
  - `svc/agents-metrics` exists, but `/metrics` on that service currently returns `404`.
- Torghut guardrails exporters are healthy:
  - `torghut-llm-guardrails-exporter` exposes LLM counters.
  - `torghut-clickhouse-guardrails-exporter` exposes ClickHouse freshness/disk metrics.
- Jangar Torghut trading API gap:
  - `/api/torghut/trading/strategies` and `/api/torghut/trading/summary` returned
    `self signed certificate in certificate chain`.

## Problem Statement

Without a unified control plan, operators cannot reliably answer:

- Is Jangar control plane truly healthy or just partially alive?
- Are Torghut context and LLM paths operating within safe bounds?
- Is a LEAN execution rollout within objective guardrails or drifting?
- Are quant/trading APIs healthy end-to-end or failing due to DB TLS trust-chain issues?

## Control Objectives

1. Detect control-plane degradation in under 5 minutes.
2. Detect Torghut decision-context data staleness before it affects decisions.
3. Keep LEAN rollout gated behind measurable parity and TCA thresholds.
4. Provide one operational dashboard for "can we continue safely?" decisions.

## Control Surface Design

### Layer 1: Health

- Jangar:
  - `/health`
  - `/api/agents/control-plane/status?namespace=agents`
  - `/api/torghut/trading/strategies` (DB trust-chain probe)
- Torghut:
  - `/healthz`
  - `/trading/status`

Required behavior:

- expose separate health for control-plane API and each controller lane,
- include leader-election state and CRD readiness,
- mark partial degradation explicitly (not just binary up/down).

### Layer 2: Metrics

- Jangar metrics (OTEL + Prometheus route):
  - `jangar_reconcile_duration_ms`
  - `jangar_agent_run_outcomes_total`
  - `jangar_agents_queue_depth`
  - `jangar_agents_rate_limit_rejections_total`
  - `jangar_leader_changes_total`
- Torghut LLM guardrails:
  - `torghut_llm_requests_total`
  - `torghut_llm_error_total`
  - `torghut_llm_validation_error_total`
  - `torghut_llm_guardrails_last_scrape_success`
- Torghut data-plane guardrails:
  - `torghut_clickhouse_guardrails_last_scrape_success`
  - `torghut_clickhouse_guardrails_ta_signals_max_event_ts_seconds`
  - `torghut_clickhouse_guardrails_disk_free_ratio`

### Layer 3: Alerts

Minimum alerts (page-worthy):

- Jangar control-plane degraded for > 5m.
- Controllers not started or runtime adapter degraded for > 10m.
- Prometheus metrics endpoint unavailable for > 5m.
- Torghut LLM error ratio > 10% over 15m.
- TA signal freshness lag > 120s for > 10m.
- ClickHouse disk free ratio < 15%.

### Layer 4: Change Controls

- Feature flags for market-context and LEAN adapter routing must be:
  - declared in GitOps manifests,
  - auditable in PR diffs,
  - reversible in one revert commit.
- Every LEAN rollout step must carry:
  - canary scope,
  - stop condition,
  - rollback trigger.

## SLO Matrix

| Control area                      | SLO target            | Breach action                                     |
| --------------------------------- | --------------------- | ------------------------------------------------- |
| Jangar API availability           | >= 99.9% monthly      | page oncall + freeze non-emergency rollouts       |
| Controller reconcile latency      | p95 < 5s              | scale controllers / inspect queue pressure        |
| Controller degraded duration      | < 10m continuous      | auto-create incident + force diagnosis runbook    |
| Metrics endpoint availability     | >= 99.5% monthly      | block releases touching controllers               |
| Torghut LLM error ratio           | < 10% (15m window)    | force shadow-only and investigate prompt/provider |
| TA freshness lag                  | < 120s                | pause autonomous promotion and investigate ingest |
| LEAN parity mismatch rate (paper) | 0 critical mismatches | block promotion to live canary                    |

## Dashboard Contract

### Dashboard 1: "Jangar Control Plane"

- Leader status (current leader pod).
- Controller started/degraded states by lane.
- AgentRun throughput and failure ratio.
- Queue depth and reconcile latency histograms.

### Dashboard 2: "Torghut Decision Safety"

- LLM request/approve/veto/error rates.
- LLM circuit status and guardrail shadow counters.
- TA signal freshness and ClickHouse guardrail metrics.

### Dashboard 3: "LEAN Rollout Gate"

- Adapter selection share (`alpaca` vs `lean` in paper).
- Parity mismatches over time.
- TCA drift (`shortfall_bps`, `slippage_p95`) between adapters.
- Canary symbol/account scope and incident markers.

## Implementation Plan

### Workstream A: Fix control-plane observability gaps

Owned areas:

- `services/jangar/server.ts`
- `services/jangar/src/server/metrics.ts`
- `services/jangar/src/server/torghut-trading-db.ts`
- `charts/agents/templates/metrics-service.yaml`
- `charts/agents/templates/metrics-servicemonitor.yaml`
- `argocd/applications/agents/values.yaml`
- `argocd/applications/jangar/deployment.yaml`

Deliverables:

- guarantee `/metrics` availability when metrics are enabled,
- add startup self-check that fails readiness if metrics route is misconfigured,
- fix `TORGHUT_DB_DSN` TLS trust-chain contract so `/api/torghut/trading/*` endpoints are reliable,
- enable `metrics.serviceMonitor.enabled` in GitOps where Prometheus Operator is present.

### Workstream B: Controller health truthfulness

Owned areas:

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/agents-controller.ts`
- `services/jangar/src/server/supporting-primitives-controller.ts`
- `services/jangar/src/server/orchestration-controller.ts`

Deliverables:

- status endpoint must distinguish "disabled", "follower", and "leader-not-started" states,
- reduce false degraded signals on follower pods,
- add explicit error counters for repeated NotFound patch loops.

### Workstream C: LEAN rollout controls

Owned areas:

- `argocd/applications/torghut/knative-service.yaml`
- `argocd/applications/torghut/autonomy-configmap.yaml`
- Torghut execution modules (`services/torghut/app/trading/**`)

Deliverables:

- explicit `TRADING_EXECUTION_ADAPTER` switch with safe default (`alpaca`),
- canary-only adapter routing policy (symbol/account allowlist),
- rollback procedure validated in paper before live canary.

## Operational Runbook Additions

### Daily checks

```bash
kubectl -n agents get deploy,pods
kubectl -n agents logs deploy/agents-controllers --tail=200
kubectl -n torghut get ksvc torghut
kubectl -n torghut get deploy torghut-llm-guardrails-exporter torghut-clickhouse-guardrails-exporter
```

### Incident checks

```bash
kubectl -n agents port-forward svc/agents 8080:80
curl -fsS "http://127.0.0.1:8080/api/agents/control-plane/status?namespace=agents" | jq .

kubectl -n torghut port-forward svc/torghut-llm-guardrails-exporter 9110:9110
curl -fsS http://127.0.0.1:9110/metrics | rg "^torghut_llm_"
```

### Emergency safe posture

- Force LLM advisory to shadow/pass-through only.
- Freeze autonomous promotions.
- Route execution adapter to native fallback until parity/TCA restored.

## Risks and Mitigations

- Split-brain health perception between control-plane and controllers:
  - Mitigate with leader/follower-aware status semantics.
- Silent metrics regressions:
  - Mitigate with readiness checks tied to metrics route availability.
- LEAN rollout confidence without parity evidence:
  - Mitigate with hard promotion gates tied to parity and TCA metrics.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `jangar-trading-control-plan-impl-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `agentsNamespace`
  - `torghutNamespace`
  - `gitopsPath`
  - `designDoc`
- Expected artifacts:
  - control-plane status/metrics improvements,
  - dashboard + alert rule manifests,
  - runbook updates for daily and incident workflows,
  - LEAN rollout control toggle manifests.
- Exit criteria:
  - metrics route scrapeable in-cluster,
  - controller status reflects true runtime state,
  - alert rules tested,
  - rollback rehearsal completed for adapter switch.
