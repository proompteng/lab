# PostHog Agent Observability and Error Tracking Production Design

## Status

- Doc: `v6/12`
- Date: `2026-03-03`
- Maturity: `production design`
- Scope: production-grade PostHog adoption for Torghut agent observation, error tracking, LLM telemetry, and feature-flag strategy
- Implementation status: `Planned`
- Evidence:
  - `argocd/applications/posthog/**` (self-hosted platform manifests)
  - `argocd/applications/torghut/knative-service.yaml` (runtime env and feature-flag wiring)
  - `services/torghut/app/trading/scheduler.py` (loop-level failure boundaries and runtime control points)
- Rollout gap: Torghut has metrics/logs coverage via Alloy+Mimir+Loki, but no first-class PostHog domain telemetry or error-tracking pipeline.

## Objective

Maximize PostHog value for Torghut without weakening trading safety:

1. add production error tracking and incident triage context,
2. add high-fidelity agent and LLM observation trails,
3. preserve deterministic execution and risk controls as final authority,
4. keep canonical financial accounting outside PostHog.

## Non-Negotiable Invariants

1. PostHog must never be on the critical path for trade execution decisions.
2. If PostHog is degraded, trading loops continue and only telemetry is dropped/degraded.
3. Canonical P&L, TCA, and risk evidence remain in Torghut DB/warehouse artifacts.
4. Safety-critical flags remain fail-safe and auditable during migration.
5. No secrets, tokens, or full raw LLM prompts/responses are emitted to PostHog.

## Current Baseline

### Observability and Runtime

- Torghut emits Prometheus metrics at `/metrics` and Alloy ships logs/metrics to Mimir/Loki.
- Trading loops already isolate major failure boundaries (`trading`, `reconcile`, `autonomy`, `evidence`) with explicit exception handling.
- Feature flags resolve via Flipt-compatible boolean evaluation (`POST /evaluate/v1/boolean`).

### PostHog Platform

- PostHog is self-hosted in Kubernetes via Argo CD (`posthog` namespace).
- Exposed components include web, events, plugins, worker, Postgres, Redis, and ClickHouse.
- External UI host: `https://posthog.proompteng.ai`.

## Architecture Decision

Use a split observability model:

1. `Mimir/Loki/Tempo`: infrastructure and low-level SRE telemetry.
2. `PostHog`: product-domain analytics, error intelligence, agent/LLM behavior analysis, and non-critical experimentation telemetry.

This split keeps high-volume infra telemetry cost-efficient and preserves PostHog for high-value business/behavior analysis.

## Data Ownership and Boundaries

### System of Record

- Financial truth (positions, fills, realized/unrealized P&L, cost accounting, compliance evidence):
  - Torghut relational tables and governance artifacts.
- PostHog stores derived behavioral signals and operational outcomes only.

### Correlation Model

Every emitted PostHog event must include stable join keys where available:

- `torghut_run_id` (autonomy/research lifecycle),
- `execution_correlation_id` (execution path),
- `trade_decision_id` (UUID string),
- `candidate_id` and `recommendation_trace_id` (autonomy governance),
- `account_label`, `symbol`, `strategy_id`, `trading_mode`.

## Telemetry Contract

### Event Taxonomy (Canonical)

All event names are prefixed with `torghut.`.

1. Decisioning:
   - `torghut.decision.generated`
   - `torghut.decision.skipped`
   - `torghut.decision.blocked`
2. Execution:
   - `torghut.execution.submitted`
   - `torghut.execution.rejected`
   - `torghut.execution.filled`
   - `torghut.execution.fallback`
3. Reconciliation:
   - `torghut.reconcile.batch_completed`
   - `torghut.reconcile.batch_failed`
4. Autonomy:
   - `torghut.autonomy.cycle_started`
   - `torghut.autonomy.cycle_completed`
   - `torghut.autonomy.cycle_failed`
   - `torghut.autonomy.promotion_blocked`
   - `torghut.autonomy.rollback_triggered`
5. LLM:
   - `torghut.llm.review_requested`
   - `torghut.llm.review_completed`
   - `torghut.llm.review_fallback`
   - `torghut.llm.review_failed`
6. Runtime and incidents:
   - `torghut.runtime.loop_failed`
   - `torghut.runtime.db_exception`
   - `torghut.runtime.feature_flag_resolve_failed`

## Property Governance

### Required properties

- `service`: `torghut`
- `env`: `dev|stage|prod`
- `event_version`: integer
- `timestamp_utc`: RFC3339
- `severity`: `info|warning|error|critical`

### Allowed dimensions (bounded cardinality)

- `strategy_id`, `symbol`, `trading_mode`, `account_label`
- `adapter`, `fallback_reason`, `classification`, `verdict`
- `gate_name`, `gate_status`, `regime_label`, `uncertainty_band`

### Prohibited payloads

- credentials or secret-bearing fields (`api_key`, `authorization`, DSN passwords),
- raw `input_json`/`response_json` blobs from LLM reviews,
- full broker order payloads,
- arbitrary stack-local objects without redaction.

## Error Tracking Contract

### Capture Strategy

1. Enable automatic exception capture in PostHog Python SDK.
2. Add manual capture at known loop guardrails to enrich context.
3. Deduplicate repetitive failures via fingerprinting keys.

### Priority capture points

1. FastAPI DB exception handler.
2. Trading loop guard failures.
3. Reconcile loop guard failures.
4. Autonomous loop guard failures.
5. Evidence continuity failures.
6. Autonomous lane execution failure boundary.

### Error Enrichment Schema

For captured exceptions, attach:

- `loop`: `trading|reconcile|autonomy|evidence|http`
- `account_label` if available,
- `last_run_at`, `autonomy_failure_streak`, `kill_switch_enabled`,
- `feature_flags_source`: `flipt|posthog|dual`,
- `correlation_context_present`: boolean.

## LLM and Agent Observation Contract

### LLM telemetry goals

1. trace model behavior and reliability by provider/path,
2. monitor fallback and timeout pressure,
3. measure decision quality movement without exposing sensitive prompt content.

### Required LLM event fields

- `provider`: `jangar|openai|self_hosted`
- `model`
- `latency_ms`
- `tokens_prompt`, `tokens_completion` when available,
- `result`: `success|fallback|error`,
- `failure_class` when failed,
- `policy_mode` and `prompt_version`.

### Jangar SSE path handling

For Jangar streaming completions, emit start and terminal events around request lifecycle.
If token usage is absent, emit `usage_available=false` and avoid null-heavy payload noise.

## Feature Flags Strategy

### Phase policy

1. Keep Flipt for safety-critical runtime controls initially:
   - `trading_enabled`,
   - `trading_live_enabled`,
   - kill-switch and emergency-stop controls,
   - live-promotion controls.
2. Use PostHog flags first for non-critical behavior and experiments.
3. Optional later migration uses dual-read comparator before cutover.

### Dual-read comparator contract

When enabled:

1. evaluate both flag sources,
2. emit `torghut.runtime.feature_flag_compare` with:
   - `flag_key`,
   - `flipt_enabled`,
   - `posthog_enabled`,
   - `match` boolean,
3. block migration until mismatch SLO is satisfied for consecutive windows.

## Reference Implementation Plan

### Code additions

1. Add `services/torghut/app/observability/posthog.py`:
   - client bootstrap,
   - safe capture helpers,
   - redaction and property allowlist,
   - bounded queue and best-effort flush.
2. Add `services/torghut/app/observability/contracts.py`:
   - typed event/property contracts,
   - event versioning constants.
3. Wire lifecycle hooks in `services/torghut/app/main.py` lifespan startup/shutdown.
4. Instrument loop guardrails in `services/torghut/app/trading/scheduler.py`.
5. Instrument LLM lifecycle in `services/torghut/app/trading/llm/client.py`.

### Runtime configuration contract

Add envs to Torghut Knative Service:

- `POSTHOG_ENABLED` (`true|false`)
- `POSTHOG_HOST` (in-cluster URL or external endpoint)
- `POSTHOG_API_KEY` (secret)
- `POSTHOG_PROJECT_ID`
- `POSTHOG_CAPTURE_ERRORS`
- `POSTHOG_CAPTURE_LLM`
- `POSTHOG_FLUSH_INTERVAL_SECONDS`
- `POSTHOG_QUEUE_MAX_EVENTS`
- `POSTHOG_SAMPLE_RATE_ERRORS`
- `POSTHOG_SAMPLE_RATE_EVENTS`

Store sensitive values in `argocd/applications/torghut/sealed-secrets.yaml`.

### Platform hardening (GitOps)

1. Ensure PostHog component resource requests/limits are explicit for web/events/plugins/worker.
2. Define backup/retention policy for Postgres and ClickHouse backing PostHog.
3. Add PostHog health probes to operational dashboards.
4. Add cluster-local network policy for Torghut -> PostHog ingestion paths.

## Reliability and Performance Requirements

1. Maximum synchronous telemetry overhead per trading iteration: `<= 5 ms p95`.
2. Telemetry queue saturation must drop events with counters, not block loop progress.
3. PostHog outage behavior:
   - emit local warning log once per backoff window,
   - continue trading operations,
   - increment dropped-telemetry counter.

## Security and Compliance

1. Enforce property redaction before capture.
2. Strip stack locals/code variables unless explicitly allowlisted.
3. Keep audit-grade evidence in Torghut DB/artifacts; PostHog is secondary analytics.
4. Restrict PostHog access roles for trading-sensitive telemetry.

## SLOs and Alerting

### SLOs

1. Telemetry delivery success ratio (best effort): `>= 99%` over 1h when PostHog healthy.
2. Exception-to-alert latency: `<= 2 minutes`.
3. Feature-flag comparator mismatch (dual-read phase): `<= 0.1%`.
4. PostHog-induced loop latency regression: `< 2%` relative baseline.

### Alerts

1. `TorghutPosthogCaptureFailureSpike`
2. `TorghutPosthogQueueDropsHigh`
3. `TorghutFeatureFlagSourceMismatch`
4. `TorghutLLMFallbackRateSpike`
5. `TorghutUnhandledExceptionRateSpike`

Every alert must map to explicit runbook actions and owner.

## Rollout Plan

### Phase 0: contract + schema

- Land contracts and redaction policy.
- No runtime emissions yet.

Exit:

1. contract review approved,
2. lint/type/tests pass.

### Phase 1: error tracking

- Enable error capture + loop/manual enrichment.
- Validate deduplication and noise controls.

Exit:

1. exception events visible in PostHog,
2. no loop latency regression beyond threshold.

### Phase 2: domain events

- Add decision/execution/reconcile/autonomy events.
- Validate cardinality and dashboard utility.

Exit:

1. funnel dashboards operational,
2. no prohibited fields detected.

### Phase 3: LLM observation

- Add LLM lifecycle events across OpenAI and Jangar paths.
- Add fallback/error analytics board.

Exit:

1. model-path reliability analytics available,
2. prompt/body leakage checks pass.

### Phase 4: non-critical flag experiments

- Enable PostHog non-critical flags.
- Keep Flipt for critical runtime controls.

Exit:

1. stable evaluation latency,
2. no production control regressions.

### Phase 5: optional dual-read migration

- Dual-read comparator for selected flags.
- Migrate only after sustained parity.

Exit:

1. parity SLO sustained for required window,
2. rollback validated.

## Validation Plan

### Automated tests

1. unit tests for redaction and allowlist enforcement,
2. unit tests for non-blocking capture and queue-drop behavior,
3. integration tests for event emission at loop boundaries,
4. regression tests for feature-flag dual-read mismatch classification.

### Runtime verification commands

1. verify Torghut env wiring from Knative manifest/revision,
2. verify PostHog ingestion endpoints are reachable from Torghut namespace,
3. trigger controlled synthetic exception and confirm capture,
4. assert trading loop remains healthy during temporary PostHog endpoint blackhole.

## Rollback Plan

Immediate rollback switches:

1. set `POSTHOG_ENABLED=false` to disable runtime capture,
2. preserve all existing Mimir/Loki/Tempo and Torghut DB evidence paths,
3. revert PostHog-specific env and code changes if any safety regression is detected.

Rollback must be rehearsed before Phase 3 completion.

## Ownership

- Service integration owner: `torghut` maintainers
- Platform owner: `posthog` ArgoCD application owners
- Governance owner: trading ops and MRM
- Incident owner: oncall SRE + trading operator

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v6-posthog-observability-v1`
- Required parameters:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `artifactPath`
  - `posthogHost`
  - `posthogProjectId`
  - `eventContractVersion`
- Expected artifacts:
  - `posthog-event-contract.json`
  - `posthog-redaction-report.json`
  - `posthog-load-test-summary.json`
  - `posthog-rollout-checklist.md`
- Exit criteria:
  - all phase gates pass,
  - no critical data-leak findings,
  - no blocking runtime regressions.
