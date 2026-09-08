# 111. Torghut Reciprocal Evidence Authority And Profit Escrow (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Implemented/partially evolved: Torghut GitOps, migrations, release workflows, and scripts exist; post-deploy verification wiring has changed over time.
- Matched implementation area: CI/CD, release, GitOps, Argo, Knative, and deployment automation.
- Current source evidence:
  - `argocd/applications/torghut/knative-service.yaml`
  - `argocd/applications/torghut/db-migrations-job.yaml`
  - `.github/workflows/torghut-ci.yml`
  - `.github/workflows/torghut-release.yml`
  - `packages/scripts/src/torghut/update-manifests.ts`
- Design drift note: Deployment docs must be checked against current workflows because old names have been retired or replaced.


## Decision

Torghut will consume Jangar **settled evidence verdicts** before it promotes any strategy from observation to paper or
live capital. Fresh local dependencies are necessary but not sufficient.

The current Torghut state proves why. `/db-check` is clean at Alembic head `0029_whitepaper_embedding_dimension_4096`,
Postgres and ClickHouse are healthy, Alpaca reports the live account active, the Jangar universe is fresh with `12`
symbols, and Jangar typed quant health is current with `latestMetricsCount=3780` and `metricsPipelineLagSeconds=0`.
At the same time, `/readyz` and `/trading/health` return HTTP `503`, live submission is blocked by
`simple_submit_disabled`, capital stage is `shadow`, promotion-eligible hypotheses are `0`, and empirical jobs are
stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.

That is the right conservative result. What is missing is a profitable path forward that does not require reopening
capital too early. The chosen design is a profit escrow: Torghut may run observation and zero-notional shadow
experiments when Jangar verdicts are repair-only or observe-only, but it cannot paper trade, live micro-canary, or scale
until the Jangar verdict has no open contradiction cases and Torghut acknowledges the exact DB, quant, empirical, TCA,
and live-submission evidence it consumed.

The tradeoff is slower promotion. I accept it because stale empirical proof from `2026-03-21` should not authorize
capital on `2026-05-06`, even if the route and database are green. Torghut should buy learning with shadow evidence and
spend capital only after the evidence chain is reciprocal and current.

## Evidence Snapshot

- `curl /healthz` returned HTTP `200`.
- `curl /db-check` returned `ok=true`, expected/current head
  `0029_whitepaper_embedding_dimension_4096`, one schema head, no duplicates, no orphan parents, and account scope
  ready.
- Schema graph lineage is usable but still has known parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `curl /readyz` returned HTTP `503`; the dependencies for Postgres, ClickHouse, Alpaca, database schema, universe, and
  quant evidence were healthy or not-required, while `live_submission_gate.ok=false` because `simple_submit_disabled`.
- `curl /trading/health` returned HTTP `503` with `promotion_eligible_total=0`, `rollback_required_total=3`,
  `capital_stage=shadow`, and dependency quorum blocked by `empirical_jobs_degraded`.
- `curl /trading/autonomy` reported autonomy disabled, stale empirical jobs over `intraday_tsmom_v1@prod`, dataset
  `torghut-full-day-20260318-884bec35`, and no emergency stop active.
- Options catalog and options enricher were ready; the enricher reported
  `last_success_ts=2026-05-06T08:24:47.939199+00:00`.
- Jangar could not use direct pod exec or CNPG psql from this runtime, so Torghut must expose read-only projections that
  are strong enough for Jangar to cite without database shell access.

## Problem

Torghut has three distinct states that the current readiness output compresses too tightly:

1. **Operationally alive**: routes, scheduler, Postgres, ClickHouse, universe, and broker are reachable.
2. **Experiment-ready**: data is fresh enough to produce zero-notional observations or proof-repair runs.
3. **Capital-ready**: empirical jobs, TCA, live-submission gate, account scope, quant health, rollback readiness, and
   Jangar promotion verdict are current and mutually consistent.

The system is in state 1 and partly in state 2. It is not in state 3. Torghut needs an architecture that lets it learn
from fresh options and quant evidence without pretending stale empirical jobs are good enough for capital.

## Alternatives Considered

### Option A: Keep Live Submission Disabled Until All Proof Is Fresh

Pros:

- Safest capital posture.
- No new Jangar integration required.
- Easy rollback story.

Cons:

- Does not use fresh options enrichment or current quant metrics.
- Does not create the evidence needed to retire stale empirical proof.
- Keeps profitability dependent on manual refreshes.

Decision: reject as the normal path. Keep it as the emergency fail-closed state.

### Option B: Let Torghut Decide From Local Readiness Alone

Pros:

- Fastest path to paper/live experiments.
- Avoids cross-plane coupling.
- Uses data Torghut already owns.

Cons:

- Repeats the current weakness: Torghut can miss Jangar-side rollout, source-schema, or evidence-classifier conflicts.
- Does not give deployers a single promotion receipt.
- Allows route/database health to outrank proof freshness.

Decision: reject. Capital promotion must be cross-plane because rollout and evidence authority are cross-plane.

### Option C: Profit Escrow Backed By Jangar Settled Evidence Verdicts

Pros:

- Allows observation and shadow learning without granting capital.
- Forces Torghut to acknowledge exactly which Jangar verdict and local evidence it consumed.
- Gives stale empirical jobs a repair path instead of a permanent block.
- Makes options experiments measurable while keeping live orders disabled.

Cons:

- Adds one more gate to promotion.
- Requires API wiring from Torghut status and submission council to Jangar verdicts.
- Requires clear operator language so "observe allowed" is not confused with "capital allowed."

Decision: select Option C.

## Profit Hypotheses

Hypothesis 1: **Options liquidity shadow sleeve**. When options catalog/enricher are ready and Jangar verdict allows
`torghut_observe`, Torghut should collect zero-notional option quote, spread, depth, and simulated order-quality
features for the top hot-set candidates. Success is at least `20` timestamped observations per market session per
candidate group, with no live orders and no promotion if empirical jobs remain stale.

Hypothesis 2: **Quant-health reciprocal gate**. Torghut should configure Jangar typed quant health as an explicit
consumer input. Success is that `/trading/health` includes a Jangar verdict id and a quant-health evidence ref, and
promotion remains blocked when the verdict has an open contradiction case even if local metrics are fresh.

Hypothesis 3: **Proof refresh profitability ladder**. Stale empirical jobs should be rerun as named proof-repair work
before any capital step. Success is all four stale jobs refreshed inside a `24h` proof window, TCA coverage refreshed
inside the same window, and at least one hypothesis moving from `shadow` to `paper_candidate` only when post-cost
evidence beats the configured hurdle.

## Architecture

Torghut adds a `profit_escrow_receipt` to health, autonomy, and submission-council surfaces:

```text
profit_escrow_receipt
  receipt_id
  jangar_verdict_id
  action_class                   # torghut_observe, proof_repair, paper_canary, live_micro_canary, live_scale
  account_ref
  evidence_window
  db_check_ref
  quant_health_ref
  empirical_job_refs
  tca_ref
  live_submission_gate_ref
  decision                       # allow_observe, allow_repair, hold_capital, allow_paper, allow_live
  blocked_reasons
  expires_at
```

The receipt is not an order permission by itself. It is an input to the live-submission gate. The gate remains
fail-closed if `simple_submit_disabled`, emergency stop is active, account scope is not ready, empirical proof is stale,
TCA is stale, quant health is missing when required, or the Jangar verdict has open contradiction cases.

## Implementation Scope

- Add configuration for the Jangar settled-verdict endpoint next to the existing quant-health URL settings.
- Extend `build_live_submission_gate_payload` to include a `profit_escrow_receipt`.
- Extend `/readyz`, `/trading/health`, `/trading/status`, and `/trading/autonomy` to surface the receipt and the
  decision class.
- Add a shadow-only options experiment runner that can execute under `allow_observe` and cannot submit broker orders.
- Add proof-repair orchestration for the four stale empirical jobs and current TCA coverage.

## Validation Gates

- Unit test: missing Jangar verdict keeps `paper_canary`, `live_micro_canary`, and `live_scale` held.
- Unit test: observe-only verdict allows zero-notional options observations but does not allow paper or live orders.
- Unit test: open Jangar contradiction case holds capital even when local DB, ClickHouse, Alpaca, universe, and quant
  health are fresh.
- Integration test: `/trading/health` and `/readyz` return the same `profit_escrow_receipt` decision used by the
  submission council.
- Data gate: stale empirical jobs are refreshed within `24h` before any paper promotion.
- Profit gate: paper promotion requires post-cost evidence above the configured hurdle and current TCA coverage.

## Rollout And Rollback

Phase 0: surface receipt fields in shadow with no behavior change. Current live submission remains blocked.

Phase 1: allow zero-notional options observations under `allow_observe`. Rollback is to disable the shadow experiment
runner; no broker state changes are possible.

Phase 2: allow proof-repair jobs under `allow_repair`. Rollback is to stop scheduling repair jobs and keep stale
empirical proof as the blocking reason.

Phase 3: require `profit_escrow_receipt.decision=allow_paper` before paper canaries and `allow_live` before any live
micro-canary. Rollback is to force the receipt decision back to `hold_capital` and leave `simple_submit_disabled` true.

## Risks

- A receipt could become stale while a long-running experiment is still executing. Every receipt must expire and be
  rechecked before promotion.
- Options observations can create false confidence if they are not tied to realized spreads and simulated order-quality
  metrics. The hypothesis must record both.
- Jangar verdict latency can block profitable paper work during market hours. The safe bypass is observe-only, not
  live capital.
- Empirical refresh can overfit to a narrow window. Promotion requires held-out, post-cost evidence and TCA coverage.

## Handoff

Engineer acceptance gate: implement receipt plumbing, add tests for observe-only, repair-only, missing-verdict, and
open-contradiction paths, and keep live submission blocked until all capital inputs are current.

Deployer acceptance gate: do not promote Torghut past shadow unless `/trading/health`, `/readyz`, and the submission
council all cite the same fresh Jangar verdict id and `profit_escrow_receipt.decision` for the requested action.
