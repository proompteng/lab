# 30. Live State Disposition and Implementation/Rollout Gates for `torghut` Quant (2026-03-06)

## Status

- Date: `2026-03-06`
- Maturity: `architecture closeout + rollout gate update`
- Scope: `torghut` live cluster/runtime, current `main` source shape, and database/readiness contracts
- Primary objective: convert the March 6 architecture designs into a single current-state disposition that says what to keep, what to implement next, and what must stay blocked until live evidence becomes truthful.

## Executive Summary

The current live `torghut` system is operationally healthy but still not empirically ready to consume meaningful capital.

Observed live state from `2026-03-06T09:12Z`:

- `torghut-00068` reports `/readyz.status=ok` and `/db-check.ok=true`.
- `/db-check` reports current heads `0016_llm_dspy_workflow_artifacts` and `0017_whitepaper_semantic_indexing`, with no missing heads and a tolerated branched graph.
- `/trading/status` reports `enabled=true`, `autonomy_enabled=true`, `mode=live`, and `running=true`, but also:
  - `autonomy.runs_total=0`
  - `autonomy.signals_total=0`
  - `autonomy.no_signal_streak=24`
  - `metrics.feature_batch_rows_total=0`
  - `metrics.drift_detection_checks_total=0`
  - `metrics.evidence_continuity_checks_total=0`
  - `metrics.autonomy_promotion_blocked_total=24`
  - `tca.avg_abs_slippage_bps~=28.66`
- The active pod environment still has `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false` and `TRADING_MULTI_ACCOUNT_ENABLED=false`.
- Jangar control-plane status currently reports all three controllers as `disabled`, while `rollout_health.status=unknown`.

That means the March 6 designs remain directionally correct:

1. maintain the deterministic safety core and fail-closed promotion posture;
2. improve the runtime truth surface before enabling any new live promotion path;
3. innovate only after the system proves fresh signals, feature coverage, evidence continuity, and dependency truth in live or shadow windows.

## Assessment Basis

### Cluster/runtime evidence

- `curl -fsS http://10.109.159.121:8012/readyz | jq`
- `curl -fsS http://10.109.159.121:8012/db-check | jq`
- `curl -fsS http://10.109.159.121:8012/trading/status | jq`
- `curl -fsS "http://${AGENTS_SERVICE_HOST}/api/agents/control-plane/status?namespace=agents" | jq`
- `kubectl get pod torghut-00068-deployment-7978449cbb-lmbkv -n torghut -o json | jq`
- `kubectl get configmap torghut-autonomy-config -n torghut -o yaml`

### Source evidence

- `docs/torghut/design-system/v6/27-live-hypothesis-ledger-and-capital-allocation-contract-2026-03-06.md`
- `docs/torghut/design-system/v6/28-hypothesis-led-alpha-readiness-and-profit-circuit-2026-03-06.md`
- `docs/torghut/design-system/v6/29-code-investigated-vnext-architecture-reset-2026-03-06.md`
- `services/torghut/app/whitepapers/workflow.py`
- `services/torghut/app/models/entities.py`
- `services/torghut/migrations/versions/0016_whitepaper_engineering_triggers_and_rollout.py`
- `services/jangar/src/server/control-plane-status.ts`
- `argocd/applications/torghut/knative-service.yaml`
- `docs/torghut/postgres-table-reference.md`

## Verified Current State

### 1. Cluster state: healthy runtime, absent alpha throughput

The live service is up and serving health endpoints successfully, but the live alpha path is inert.

Important facts from `/trading/status`:

- `autonomy.last_reason=cursor_ahead_of_stream`
- `autonomy.last_ingest_signal_count=0`
- `signal_continuity.alert_active=true`
- `signal_continuity.alert_reason=cursor_ahead_of_stream`
- `signal_continuity.market_session_open=false`
- `metrics.no_signal_reason_total.cursor_tail_stable=1385`
- `metrics.no_signal_reason_total.cursor_ahead_of_stream=24`
- `metrics.signal_lag_seconds=40438`
- `metrics.feature_batch_rows_total=0`
- `metrics.drift_detection_checks_total=0`
- `metrics.evidence_continuity_checks_total=0`
- `metrics.autonomy_recommendation_total.shadow=24`

This is a fail-closed runtime posture, which is good. It is not a profitable trading posture, which is the central
architectural issue for this lane.

### 2. Dependency truth is still weaker than capital truth requires

Jangar control-plane status currently returns:

- `controllers.agents-controller.status=disabled`
- `controllers.supporting-controller.status=disabled`
- `controllers.orchestration-controller.status=disabled`
- `rollout_health.status=unknown`

Even with `database.status=healthy` and workflow data confidence reported as high, this is not strong enough to justify
live-capital promotion. A separate dependency quorum contract is still required so Torghut can treat this state as
`delay` or `block` instead of leaving operators to infer it from several unrelated fields.

### 3. Database state is healthy, but profitability state is still missing

The database/readiness contract is healthy:

- expected heads are present;
- schema signatures are stable;
- the branched migration graph is currently tolerated and explicitly surfaced;
- account-scope checks are bypassed only because multi-account trading remains disabled.

The missing piece is not schema freshness. The missing piece is live profitability state.

Current source still stops at whitepaper-trigger and rollout-transition metadata:

- `services/torghut/app/whitepapers/workflow.py` derives and persists `hypothesis_id`;
- `services/torghut/app/models/entities.py` defines `WhitepaperRolloutTransition`;
- `services/torghut/migrations/versions/0016_whitepaper_engineering_triggers_and_rollout.py` persists rollout history.

Current source does not yet define first-class hypothesis-ledger or capital-allocation tables such as:

- `strategy_hypotheses`
- `strategy_hypothesis_versions`
- `strategy_hypothesis_metric_windows`
- `strategy_capital_allocations`

So the database is healthy enough to change, but it is not yet the source of truth for profitability governance.

### 4. Source state: merged designs exist, runtime implementation on `main` does not yet match them

The architect outputs from March 6 are already merged in `main`:

- hypothesis ledger and capital-allocation design,
- hypothesis-led alpha readiness and profit circuit,
- vNext reset away from synthetic evidence authority.

But current `main` source still lacks the runtime slice those docs call for:

- no `services/torghut/app/trading/hypotheses.py` runtime on `main`;
- no hypothesis-manifest environment/configuration in `argocd/applications/torghut/knative-service.yaml`;
- no `dependency_quorum` contract in `services/jangar/src/server/control-plane-status.ts`;
- current runtime still exposes strong health and TCA surfaces without a first-class per-hypothesis capital state.

This means the architecture is ahead of the runtime, which is exactly the expected state for an architect closeout.

## Disposition: Maintain, Improve, Innovate

### Maintain

Keep these as hard invariants:

- deterministic risk, execution, and veto controls remain final authority;
- `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false` stays in effect until readiness and dependency truth are implemented;
- DB lineage/readiness checks remain strict and visible in `/db-check`;
- signal continuity, expected-market-closed classification, and shadow-only recommendations remain fail-closed;
- Jangar/Torghut rollout must continue treating disabled or unknown upstream dependency state as non-promotable.

### Improve

The next required implementation is not broader autonomy. It is runtime truthfulness.

Required near-term improvements:

1. Add source-controlled hypothesis manifests and a scheduler-side readiness compiler.
2. Expose per-hypothesis state, blockers, and capital stage in `/trading/status`.
3. Add a Jangar dependency quorum surface that collapses controller, workflow, and rollout uncertainty into
   `allow | delay | block`.
4. Tie promotion blockers directly to:
   - signal continuity,
   - feature coverage,
   - evidence continuity,
   - drift checks,
   - TCA/slippage quality.

This is the minimum change set that turns the current green-but-alpha-inert system into a truth-telling control plane.

### Innovate

Innovation remains necessary, but it must be sequenced behind truthful evidence:

- implement the live hypothesis ledger and capital-allocation tables from `v6/27`;
- replace synthetic or placeholder promotion evidence with empirical evidence per `v6/29`;
- keep higher-upside lanes such as microstructure-driven hypotheses blocked until real feature coverage exists;
- treat LLM value primarily as research, critique, and synthesis until empirical alpha maturity is proven.

The innovation bar is therefore not "add more intelligence". It is "add more truthful evidence authority".

## Required Implementation Gates

### Gate 0: Runtime truth slice

Before any promotion policy changes, the runtime must prove it can describe readiness truthfully.

Required outputs:

- per-hypothesis state in `/trading/status`;
- explicit promotion blockers and capital stage in status payloads;
- dependency quorum from Jangar exposed in a machine-evaluable way;
- metrics showing why a hypothesis is `blocked`, `shadow`, `canary_live`, or `scaled_live`.

Acceptance criteria:

- a hypothesis with `feature_batch_rows_total=0`, `drift_detection_checks_total=0`, or `evidence_continuity_checks_total=0`
  cannot report `canary_live` or `scaled_live`;
- a disabled/unknown Jangar dependency surface yields `delay` or `block`, not implicit success;
- the current live cluster state would evaluate to `shadow` or `blocked` for every hypothesis lane.

### Gate 1: Shadow evidence production

Before canary capital is discussed, live or shadow windows must produce real evidence.

Acceptance criteria:

- non-zero feature rows during market sessions;
- non-zero drift checks within the defined lookback window;
- non-zero evidence continuity checks with recent success timestamps;
- shadow decisions and counterfactual outcomes recorded per hypothesis.

### Gate 2: Canary-live eligibility

Canary eligibility requires both readiness truth and post-cost evidence.

Acceptance criteria:

- positive rolling expectancy after costs for the configured window;
- average absolute slippage within hypothesis budget;
- dependency quorum is `allow`;
- no active actionable continuity breach during market session;
- market-session sample size meets the hypothesis minimum.

### Gate 3: Ledger-backed capital governance

Scaled-live operation is blocked until the live hypothesis ledger exists.

Acceptance criteria:

- promotion and rollback can be reconstructed from DB state alone;
- capital-band changes persist prior band, new band, evidence window, and rollback target;
- hypothesis/account scope is explicit even while multi-account remains disabled by default.

## Rollout Plan

1. Land the runtime truth slice with live promotion still disabled.
2. Roll out to the cluster and verify the status contract against one full market session.
3. Keep all lanes `shadow` until feature/drift/evidence counters become non-zero and dependency quorum is truthful.
4. Introduce ledger tables and shadow writes before any canary-capital automation.
5. Require post-cost evidence plus dependency quorum `allow` before any lane is eligible for constrained-live or
   scaled-live promotion.

## Rollback Plan

1. If the runtime truth slice misclassifies readiness, revert to the current live contract and keep
   `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`.
2. If Jangar dependency quorum introduces false greens or false blocks, fall back to explicit shadow-only enforcement
   and revert the quorum integration.
3. If later ledger migrations regress readiness, revert promotion authority to artifact-only + shadow mode while keeping
   the existing DB lineage checks authoritative.
4. If any rollout causes status churn or startup instability, pin Torghut back to the last known-good revision and keep
   all hypotheses at `shadow`.

## Architect Decision

The March 6 architecture documents remain valid and should stay as source-of-truth. The current branch only needs one
additional conclusion:

`torghut` should not pursue broader live autonomy until the runtime can tell the truth about alpha readiness and
dependency quorum in one contract.

That is the correct closeout for the discover/architect lane because it preserves what is already safe, improves the
next implementation target, and keeps innovation gated behind empirical evidence instead of optimistic status.
