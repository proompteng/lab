# 30. Live State Disposition and Implementation/Rollout Gates for `torghut` Quant (2026-03-06)

## Status

- Date: `2026-03-06`
- Maturity: `architecture closeout + rollout gate update + implementation update`
- Scope: `torghut` live cluster/runtime, current `main` source shape, and database/readiness contracts
- Primary objective: convert the March 6 architecture designs into a single current-state disposition that says what to keep, what to implement next, and what must stay blocked until live evidence becomes truthful.
- Follow-up state: core runtime-truth slice landed in source on `2026-03-07`; live promotion can still remain operator-disabled

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

## Implementation update (2026-03-07)

The live snapshot below remains valuable as the March 6 baseline, but it is no longer the full current story.

Since this document was written, the core runtime-truth slice has landed in source and recorded proof:

- persistent hypothesis-governance tables now exist for hypotheses, versions, runtime metric windows, capital
  allocations, and promotion decisions;
- replay fill-price budgets, empirical job persistence, spec-backed runtime lineage, and promotion-truthfulness gates
  now feed `/trading/completion/doc29`;
- recorded proof against the main Torghut DB now reports `9/9` doc29 gates satisfied with `summary.all_satisfied=true`;
- the decisive proving replay was `sim-2026-03-06-full-day-r1`, covering the regular US session from
  `2026-03-06T14:30:00Z` to `2026-03-06T21:00:00Z`, not a 24-hour window.

Operationally, one conservative choice remains unchanged: the live cluster may continue to keep
`TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false` until operators explicitly choose to trust the recorded windows for live
capital. Proof-complete gating is not the same thing as silently enabling live capital.

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

The subsections below intentionally preserve the observed March 6 baseline that motivated this work. Read them as the
pre-closeout state, not as the current branch verdict after the March 7 implementation update above.

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

### 3. Database state was healthy on March 6, and profitability governance is now persisted

The database/readiness contract is healthy:

- expected heads are present;
- schema signatures are stable;
- the branched migration graph is currently tolerated and explicitly surfaced;
- account-scope checks are bypassed only because multi-account trading remains disabled.

On March 6, the missing piece was not schema freshness. It was live profitability state.

That gap is now closed for the proving lane. Current source extends the earlier whitepaper-trigger and
rollout-transition metadata with persisted profitability governance:

- `services/torghut/app/whitepapers/workflow.py` derives and persists `hypothesis_id`;
- `services/torghut/app/models/entities.py` defines `WhitepaperRolloutTransition`;
- `services/torghut/migrations/versions/0016_whitepaper_engineering_triggers_and_rollout.py` persists rollout history.
- `services/torghut/migrations/versions/0021_strategy_hypothesis_governance.py` now adds:
  - `strategy_hypotheses`
  - `strategy_hypothesis_versions`
  - `strategy_hypothesis_metric_windows`
  - `strategy_capital_allocations`
  - `strategy_promotion_decisions`

So the database is no longer just healthy enough to change. It now serves as the proving-lane source of truth for
profitability governance while live-capital enablement remains a separate operational decision.

### 4. Source state: the March 6 runtime gap is now closed for the doc29 truth slice

The architect outputs from March 6 are now partly realized in `main`:

- hypothesis ledger and capital-allocation design,
- hypothesis-led alpha readiness and profit circuit,
- vNext reset away from synthetic evidence authority.

The current source now includes the runtime slice those docs called for:

- persisted hypothesis-governance entities and migration-backed tables;
- runtime-window import and autonomy-lane write paths that record stage transitions, live evidence, and promotion
  lineage;
- doc29 gate derivation for promotion truthfulness, spec-backed lineage, paper eligibility, live canary, and live
  scale from recorded evidence;
- a completion surface that now reports the proving lane as fully satisfied instead of leaving operators to infer it.

This means the original architecture/runtime gap has been closed for the proving lane. The remaining separation is
operational: whether and when the live cluster should enable live-capital automation on top of that truthful state.

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

Implementation status on `2026-03-07`:

- Gate 0 (`Runtime truth slice`): satisfied in source and proof environment.
- Gate 1 (`Shadow evidence production`): satisfied for the doc29 proving lane.
- Gate 2 (`Canary-live eligibility`): satisfied in persisted gate data, while live promotion may still remain disabled
  in the cluster.
- Gate 3 (`Ledger-backed capital governance`): satisfied for the proving lane data model and decision persistence.

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

This sequence has now been executed in the proving lane through doc29 closeout. The remaining live-cluster decision is
whether to trust that recorded evidence enough to change the operator-controlled promotion flag.

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

The March 6 architecture documents remain valid and should stay as source-of-truth. The additional closeout conclusion
is narrower now:

`torghut` can tell the truth about alpha readiness and dependency quorum in one contract for the proving lane, so the
remaining question is no longer implementation truthfulness. It is whether operators want to enable live capital on top
of that truthful state.

That is the correct closeout for the discover/architect lane because it preserves what is already safe, improves the
next implementation target, and keeps innovation gated behind empirical evidence instead of optimistic status.
