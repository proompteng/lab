# 27. Live Hypothesis Ledger and Capital Allocation Contract (2026-03-06)

## Summary

Torghut already has strong artifact-level promotion controls, but profitability is still governed primarily through
file bundles and one-shot stage manifests. The system can say that a candidate has a profitability proof artifact
without maintaining a live, database-backed record of which hypothesis is currently being tested, how much capital it
has earned, and whether its paper/shadow/live performance still supports promotion. This design adds a live
hypothesis ledger that connects research, whitepaper-triggered engineering, rollout transitions, and capital
allocation into one measurable control loop.

## Assessment context

- Cluster scope: `torghut` namespace, live service and rollout state on March 6, 2026.
- Source scope: `services/torghut/**`, `argocd/applications/torghut/**`, `docs/torghut/design-system/v6/**`.
- Database scope: Torghut readiness and DB contract APIs plus source-defined schema and workflow tables.

## Evidence

### Cluster and live API evidence

- `curl http://10.97.184.95/readyz` currently reports `status=ok`, scheduler running, fresh Jangar universe data, and
  healthy Postgres/ClickHouse/Alpaca dependencies. The platform is healthy enough to support richer governance.
- The same payload shows `dependencies.database.account_scope_warnings` because account-scope checks are bypassed when
  `trading_multi_account_enabled` is false. Profitability governance is therefore not yet multi-account aware.
- `curl http://10.97.184.95/db-check` reports current heads
  `0016_llm_dspy_workflow_artifacts` and `0017_whitepaper_semantic_indexing` with a stable schema signature, so the
  immediate DB risk is not head drift. The larger issue is missing live profitability state.
- `kubectl get events -n torghut --sort-by=.lastTimestamp` shows recent revision startup/readiness churn and repeated
  config updates, which means promotion decisions need stronger live rollback criteria than static artifact presence.

### Source evidence

- `services/torghut/scripts/verify_quant_readiness.py` loads `--profitability-proof` as an optional artifact and
  validates fields like `hypothesis`, `sample_size`, `p_value`, and `drawdown_delta`, but the result is still an
  artifact check, not a live control-plane object.
- `services/torghut/app/whitepapers/workflow.py` already derives and persists `hypothesis_id`,
  `rollout_profile`, and `WhitepaperRolloutTransition` records. The system has the right join key, but not a full
  operating ledger around it.
- `argocd/applications/torghut/autonomy-gate-policy-configmap.yaml` requires
  `profitability/profitability-stage-manifest-v1.json` and related artifacts for promotion, which proves governance is
  artifact-centric today.
- `docs/torghut/postgres-table-reference.md` documents rich workflow tables
  (`whitepaper_analysis_runs`, `whitepaper_engineering_triggers`, `whitepaper_rollout_transitions`,
  semantic indexing tables), but there is no first-class `hypothesis` and `capital_allocation` data model spanning
  paper, shadow, constrained-live, and scaled-live decisions.

### Database and data evidence

- Live DB readiness is healthy and current, which means the platform can safely absorb new ledger tables and
  read models.
- Account-scope controls are bypassed in the live environment, so any profitability system that ignores account scope
  will be incomplete from day one.
- Jangar universe freshness is good (`symbols_count=12`, `cache_age_seconds=0`), so promotion logic can safely depend
  on fresh symbol-selection evidence when evaluating hypothesis cohorts.

## Problem statement

Profitability is still treated as a stage artifact, not as a continuously governed hypothesis.

That causes three system-level gaps:

1. Promotion knows that a candidate once passed a profitability proof, but not whether the live cohort tied to
   `hypothesis_id` is still earning the right to trade.
2. Capital allocation is not hypothesis-aware, so the system cannot automatically size winners up and losers down
   using the same evidence contract that approved them.
3. Rollback can respond to gate failures, but it does not yet reason in terms of hypothesis decay, regime drift, or
   cohort-specific drawdown budgets.

This is a profitability ceiling, not just a documentation gap.

## Decision

Introduce a live hypothesis ledger and capital-allocation contract that becomes the source of truth for promotion,
allocation, and rollback.

The ledger extends existing whitepaper and rollout infrastructure rather than replacing it.

## Chosen design

### 1. Hypothesis registry

Create first-class persisted objects keyed by `hypothesis_id`:

- `strategy_hypotheses`
- `strategy_hypothesis_versions`
- `strategy_hypothesis_cohorts`
- `strategy_hypothesis_metric_windows`
- `strategy_capital_allocations`
- `strategy_promotion_decisions`

Each hypothesis records:

- economic thesis,
- target market and regime assumptions,
- expected edge after costs,
- minimum sample size and maximum drawdown budget,
- benchmark family,
- owner design doc and rollout policy reference.

This turns `hypothesis_id` from metadata into an operating identity.

### 2. Cohort-based performance accounting

Every paper, shadow, constrained-live, and scaled-live action must write a cohort window tied to:

- `hypothesis_id`
- account or account group,
- symbol universe slice,
- regime label,
- execution venue,
- rollout stage.

Required metrics per window:

- decisions, fills, realized and unrealized PnL,
- slippage and cost deltas,
- drawdown and turnover,
- abstain rate, fallback rate, and veto reasons,
- benchmark-relative return and calibration drift.

This makes profitability measurable as a live time series instead of a single promotion artifact.

### 3. Sequential promotion controller

Promotion logic remains fail-closed, but it must now use live cohort evidence in addition to artifact evidence.
For each hypothesis:

- `paper -> shadow` requires artifact validity plus clean paper execution and benchmark parity.
- `shadow -> constrained_live` requires live-sim divergence within budget and a minimum effective sample size.
- `constrained_live -> scaled_live` requires positive posterior edge after costs, bounded drawdown, and benchmark
  outperformance for a defined rolling window.

The chosen statistical mechanism can be Bayesian or SPRT-based, but it must produce:

- current posterior/probability of positive edge,
- required remaining sample size,
- confidence interval width,
- rollback trigger state.

### 4. Capital-allocation contract

Capital moves from static stage bands to evidence-backed hypothesis bands:

- `exploration`: minimum notional, hard stop on weak evidence,
- `validation`: moderate notional, strict divergence and drawdown caps,
- `exploitation`: scaled notional only for hypotheses that have earned it through live evidence.

Allocation decisions must be reversible and auditable. Every notional increase or decrease writes:

- prior band,
- new band,
- evidence window used,
- approving gate result,
- rollback target band.

### 5. Jangar and operator surfaces

Jangar should not just show that a rollout profile exists. It should show:

- active hypothesis cohorts,
- current capital band and reasons,
- live promotion stage,
- blocking evidence gaps,
- rollback trigger reasons.

This gives operators one place to see whether Torghut is profitable for the right reasons, not just technically
healthy.

## Alternatives considered

### Alternative A: Keep artifact-based profitability governance only

- Pros: no schema changes and lowest implementation cost.
- Cons: no live learning loop; static evidence can drift away from current market behavior.

### Alternative B: Add dashboards without changing promotion logic

- Pros: better visibility.
- Cons: visibility without enforcement does not protect capital or improve promotion quality.

### Alternative C: Live hypothesis ledger with capital allocation (selected)

- Pros: aligns research, rollout, and capital with one measurable identity; supports genuine champion/challenger
  behavior and faster loss containment.
- Cons: requires new schema, read models, and integration work across rollout and execution paths.

## Implementation scope

### Required source areas

- `services/torghut/app/whitepapers/workflow.py`
- `services/torghut/app/trading/**`
- `services/torghut/scripts/verify_quant_readiness.py`
- `services/torghut/migrations/**`
- `argocd/applications/torghut/autonomy-gate-policy-configmap.yaml`
- Jangar read APIs that surface Torghut rollout state

### Required schema additions

- hypothesis registry tables,
- cohort metric window tables,
- allocation decision tables,
- joins from whitepaper engineering triggers and rollout transitions into hypothesis state.

### Non-goals

- Replacing existing profitability-stage manifests immediately.
- Building a new broker/execution stack in this phase.
- Enabling multi-account live trading in the same PR; this design only ensures the ledger is account-scope aware.

## Validation plan

Engineer acceptance gates:

1. Every promoted candidate has a persisted `hypothesis_id` with a live cohort row.
2. Promotion and rollback decisions can be reconstructed from database state alone.
3. Capital-band changes are impossible without a matching evidence window and gate decision.
4. Readiness and health endpoints expose whether hypothesis governance is healthy, degraded, or bypassed.
5. Tests prove that stale or insufficient live evidence prevents stage promotion even when artifact bundles exist.

Deployer acceptance gates:

1. Migration rollout preserves current healthy DB signature and readiness payloads.
2. Existing promotion artifacts remain backward-compatible during the transition.
3. A controlled paper or shadow cohort can be promoted, demoted, and replayed using only the new ledger contract.
4. Rollback to artifact-only governance is possible without data loss.

Suggested checks:

- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- `pytest services/torghut/tests -k 'whitepaper or readiness or policy'`

## Rollout plan

1. Add ledger tables and write-paths in shadow mode while keeping artifact-based promotion authoritative.
2. Start persisting cohort windows and capital-band recommendations without enforcing them.
3. Require live hypothesis windows for `shadow -> constrained_live` transitions.
4. Require live hypothesis plus capital-band contract for `constrained_live -> scaled_live`.

## Rollback plan

1. Revert promotion authority to artifact-only gating.
2. Keep ledger writes enabled if safe so evidence is preserved for later replay.
3. Freeze capital-band automation and pin all hypotheses to their previous safe band until confidence is restored.

## Risks

- Poorly tuned statistical thresholds can block promising hypotheses or scale weak ones too early.
- Missing account-scope metadata will weaken ledger usefulness when multi-account trading is enabled.
- Ledger growth can become expensive unless windows and retention are designed deliberately.

## Handoff contract

Engineer:

- Introduce hypothesis registry schema before changing rollout logic.
- Reuse existing `hypothesis_id`, whitepaper trigger, and rollout transition hooks instead of inventing parallel IDs.
- Keep artifact contracts intact until live cohort evidence is proven stable.

Deployer:

- Validate that readiness stays green and schema signatures remain current after migration.
- Require one replayed cohort promotion/demotion before trusting scaled-live automation.
- Treat missing account-scope metadata as a blocker for any future multi-account rollout.
