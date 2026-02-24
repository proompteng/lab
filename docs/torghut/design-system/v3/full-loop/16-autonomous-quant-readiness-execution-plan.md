# Autonomous Quant Readiness Execution Plan

## Status

- Version: `v3-readiness-2026-02-12`
- Owner: `torghut`
- Priority: `high`

## Objective

Deliver a fully autonomous quant stack where research, backtest, validation, deployment, and live execution are machine-runnable end-to-end with reproducible evidence and safe rollback.

## Current State (Observed 2026-02-12)

- Strategy runtime mode is `plugin_v3`.
- `TRADING_EXECUTION_ADAPTER=lean`, fallback adapter is `alpaca`.
- Autonomy enabled flag is on, but autonomous lane signals remain low in recent windows.
- Live `trading/executions` endpoint is returning route metadata as `null` for historical rows, confirming schema migration backfill and rollout coupling are incomplete.
- Research ledger tables exist, but there is no evidence queryable from the DB role currently used by torghut (`permission denied` for some tables).

## Missing Work (Critical)

1. **Backtest and walkforward pipeline into ledger**
   - Persist candidate run metadata and fold/stress metrics in `research_*` tables as the source of truth.
   - Store input feature snapshots and dataset/version fingerprints for replay.

2. **Promotion evidence artifact chain**
   - Require gate pass artifacts before paper/canary promotion.
   - Enforce policy checks at each transition (`paper -> live`, `paper -> canary`).

3. **Execution provenance closure**
   - Ensure every execution row persists both expected and actual adapter route.
   - Add operational dashboards for fallback rates and LEAN outage events.

4. **LLM governance hardening**

- Keep advisory semantics with staged rollouts.
  - Maintain challenge/evidence gating per stage.
  - Block any advisory adjustment path that violates explicit guardrails.

5. **Autonomy observability and control**
   - Add per-symbol canary/disable state and health reason for LEAN disable events.
   - Add deterministic kill-switch hooks for budget overruns and stale signals.

## Delivery Plan

### Phase A: Deterministic Evidence + Route Provenance

- Complete backfill+reconciliation for execution route metadata and add tests that assert persisted expected/actual adapter for fallback cases.

### Phase B: Research-to-Execution Closure

- Implement strict lane-to-db artifact writer for backtests.
- Add gate evaluation output schema versioning and signatures.

### Phase C: Promotion Runtime

- Wire lane output to `research_promotions` and require signed promotion record for paper/canary.
- Add AgentRun handoff requiring `run_id`, `promotion_target`, and gate proof.

### Phase D: Full Autonomous Mode

- Enable LEAN/LLM stages only after Phase A–C evidence thresholds are met over a rolling window.
- Add recovery playbook for adverse slippage, drop in autonomy signal quality, or route concentration.

## Exit Criteria

- Zero `execution_expected_adapter` nulls on new fills (legacy rows may be backfilled separately).
- Every live paper/live activation requires at least one completed gate artifact chain.
- Promotion decisions are reproducible from stored artifacts in <5 minutes.
- Autonomous loops emit alerting on critical control flags and auto-disable LEAN if circuit conditions breach thresholds.
