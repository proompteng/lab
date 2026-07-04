# 131. Torghut Session Capital Bonds And Profit Rehearsal Exchange (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

I am selecting **session capital bonds with a profit rehearsal exchange** as Torghut's next profitability architecture.

The previous contract created an evidence-product order book. That is the right repair market. It still needs a way to
earn capital through trading-session behavior. Torghut should not jump from "empirical proof is fresh" to "paper is
open" while scoped quant is empty, market context is stale, and current runtime decisions have zero executions.

At `2026-05-06T18:12Z`, Torghut live `/trading/status` reported mode `live`, active revision `torghut-00241`, and
`simple_submit_disabled` as the live submission brake. The simple lane had `17` planned decisions and `17` blocked
decisions, with `0` orders submitted. Runtime profitability over 72 hours showed `25` decisions, `0` executions, and no
TCA samples in that window. All three configured hypotheses had capital multiplier `0`: `H-CONT-01` and `H-REV-01`
were shadow, while `H-MICRO-01` was blocked. `H-REV-01` was blocked by stale market context. `H-MICRO-01` was blocked
by missing drift checks, missing feature rows, unavailable required features, and signal lag. Historical TCA still
reported high average absolute slippage, so paper or live capital cannot be justified by the current runtime path.

The positive evidence is real. Empirical jobs were healthy and authoritative for
`chip-paper-microbar-composite@execution-proof`, with fresh benchmark parity, foundation router parity, Janus event
CAR, and Janus HGRM reward artifacts. Jangar global quant health was fresh with `4032` latest metrics. ClickHouse and
Postgres were healthy through application projections.

The selected design makes each hypothesis earn a session capital bond. A bond is a zero-notional or paper rehearsal
receipt that proves the hypothesis consumed fresh products, respected current blockers, and produced measurable
post-cost learning. Capital stages then consume bonds:
`shadow_rehearsal`, `paper_probe`, `paper_canary`, `live_micro_canary`, and `live_scale`.

The tradeoff is that fresh empirical jobs become a reason to rehearse, not a reason to spend. That is the right call.
Profitability comes from learning faster without confusing blocked decisions for executable edge.

## Runtime Objective And Success Metrics

This contract increases profitability by letting Torghut accumulate evidence value while capital is held. It increases
resilience by making paper and live admission consume Jangar session receipts instead of raw route health.

Success means:

- Every hypothesis has a session bond ledger entry before it can enter paper or live.
- Fresh empirical jobs increase rehearsal priority but do not override empty scoped quant, stale context, critical
  alerts, missing feature rows, or LLM governance gaps.
- `H-MICRO-01` cannot earn paper capital until feature coverage, order-book liquidity, drift checks, and scoped quant
  are current.
- `H-REV-01` cannot earn paper capital until technicals and regime context are fresh enough for the session.
- Live capital remains impossible while `simple_submit_disabled`, LLM governance incomplete, or live-specific TCA
  settlement is active.
- Session bonds name the product ids, candidate ids, evidence snapshots, and rollback target that support the stage.
- Deployer can disable enforcement without deleting bond history.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, trading flags, broker
state, GitOps manifests, runtime objects, or artifacts.

### Cluster And Runtime Evidence

- Torghut live `torghut-00241-deployment-d899967d5-hhh6x` was `2/2 Running`.
- Torghut sim `torghut-sim-00339-deployment-6f89d5cdf-hm64m` was `2/2 Running`.
- Torghut Postgres, ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog/enricher, websockets,
  guardrail exporters, Alloy, and Symphony were running.
- Recent events showed sim rollout warm-up, sim TA restart, a failed `teardown-clean` analysis, and duplicate PDB
  matches for ClickHouse pods.
- Torghut live `/readyz` returned HTTP `503` because `simple_submit_disabled` keeps live submission in shadow.
- Torghut sim `/readyz` returned HTTP `200`; its quant evidence was degraded but not required in non-live mode.
- Direct CNPG and pod exec database inspection was forbidden to the agents service account.

### Source Evidence

- `services/torghut/app/main.py` is `4051` lines and assembles readiness, trading status, profitability runtime,
  empirical jobs, quant evidence, market context, live submission gate, and hypothesis state.
- `services/torghut/app/trading/submission_council.py` is `1196` lines and already evaluates quant health, empirical
  job readiness, market context, dependency quorum, capital stage, and candidate certificates.
- `services/torghut/app/trading/empirical_jobs.py` verifies artifact authority, truthfulness, lineage, freshness, and
  promotion eligibility.
- `services/torghut/app/trading/market_context.py` grades stale, low-quality, disabled, error, required-missing, and
  degraded-last-good market context.
- Hypothesis manifests already encode measurable gates: `H-MICRO-01` expects `10` gross bps, requires order-book
  liquidity and microstructure features, and needs 60 samples for live canary; `H-REV-01` expects `8` gross bps and
  requires market context freshness within 120 seconds.
- Tests exist for submission council, empirical jobs, market context, trading API, trading pipeline, scheduler safety,
  quant readiness, and migration graph checks.

### Database And Data Evidence

- Torghut live schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage was ready with known parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Repo-declared Torghut Postgres is one CNPG instance with `50Gi`, checksums, Barman S3 backups, `14d` retention, and a
  daily ScheduledBackup at `0 0 2 * * *`.
- Empirical jobs were healthy, with candidate `chip-paper-microbar-composite@execution-proof` and dataset snapshot
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Jangar global quant health had `latestMetricsCount=4032` and second-level freshness.
- Scoped `paper/1d` quant had `latestMetricsCount=0`, `latestMetricsUpdatedAt=null`, and
  `emptyLatestStoreAlarm=true`.
- Scoped `TORGHUT_SIM/15m` quant had `latestMetricsCount=0`, no stages, and `emptyLatestStoreAlarm=true`.
- Market-context health was degraded: technicals and regime were stale by `165119` seconds, fundamentals by `4768097`
  seconds, and news by `4401283` seconds.
- Quant alerts returned `57` open alerts, including `44` critical `metrics_pipeline_lag_seconds` alerts.
- LLM guardrails showed LLM disabled, effective shadow mode active, no policy violation, and governance evidence
  incomplete.

## Problem

Torghut is producing useful evidence and blocked decisions at the same time.

The current system can explain why live is blocked, but it cannot yet convert blocked decisions into capital-earning
proof. That matters. A session with `17` blocked decisions and `0` submitted orders is not empty. It is a rehearsal
session, but only if the system records which products were missing, which hypotheses were close, and what would have
needed to be true for the next stage.

Without session bonds, Torghut has two bad operating modes:

1. remain shadow-only until every product turns green, wasting fresh empirical evidence and hiding repair priority; or
2. reopen paper because routes are healthy, ignoring scoped quant emptiness, stale context, and execution/fillability
   debt.

Session bonds turn the middle ground into a first-class architecture.

## Alternatives Considered

### Option A: Reopen Paper For The Empirical Candidate

Pros:

- Uses the fresh `chip-paper-microbar-composite@execution-proof` artifacts.
- Creates immediate paper samples.
- Requires little new machinery.

Cons:

- Scoped `paper/1d` and sim `15m` quant stores are empty.
- Market context is stale across every domain.
- There are 44 open critical pipeline-lag alerts.
- Runtime profitability has no executions in the 72-hour window.
- `H-MICRO-01` lacks feature rows and drift checks.

Decision: reject.

### Option B: Keep All Hypotheses Shadow Until Every Product Is Green

Pros:

- Strongest capital safety.
- Simple rule for operators.
- Avoids accidental paper/live movement.

Cons:

- Does not learn from blocked decisions.
- Does not prioritize repairs by expected profit.
- Treats fresh empirical proof as operationally equivalent to stale proof.
- Makes the next session dependent on manual interpretation.

Decision: reject.

### Option C: Session Capital Bonds And Profit Rehearsal Exchange

Each hypothesis earns bonds through zero-notional or paper rehearsal. Bonds consume Jangar session receipts and
evidence products. Capital stages consume bonds.

Pros:

- Preserves capital safety while increasing learning rate.
- Turns blocked decisions into structured evidence.
- Makes repair priority measurable by expected capital unlocked.
- Gives deployer a concrete paper/live go/no-go artifact.
- Lets hypotheses decay if they repeatedly fail to earn bonds.

Cons:

- Adds a ledger and reducer.
- Requires careful anti-gaming rules for low-quality shadow decisions.
- Needs session calendar support and backfill for current blocked sessions.

Decision: select Option C.

## Architecture

### SessionCapitalBond

Torghut writes one bond per hypothesis, candidate, account, window, and session phase.

```text
session_capital_bond
  bond_id
  trading_session_id
  hypothesis_id
  candidate_id
  strategy_id
  account_label
  window
  phase                         # shadow_rehearsal, paper_probe, paper_canary, live_micro_canary, live_scale
  current_state                 # earned, partial, denied, expired, revoked
  generated_at
  expires_at
  jangar_session_rehearsal_id
  consumed_product_ids
  blocking_product_ids
  expected_gross_edge_bps
  estimated_cost_bps
  expected_post_cost_edge_bps
  sample_count
  decision_count
  execution_count
  tca_sample_count
  max_drawdown_bps
  rejection_reasons
  rollback_target
```

Bond states:

- `earned`: all required products are fresh for the phase and the hypothesis has enough clean rehearsal evidence.
- `partial`: the hypothesis produced useful zero-notional evidence but one or more products still block capital.
- `denied`: current evidence violates the phase guardrail.
- `expired`: the session or freshness window closed.
- `revoked`: a later product or settlement disproved the bond.

### ProfitRehearsalExchange

The exchange ranks partial and denied bonds by expected profit unlocked per repair.

```text
profit_rehearsal_exchange
  exchange_id
  generated_at
  trading_session_id
  ranked_bonds
  repair_orders
  capital_stage_recommendations
  rejected_shortcuts
```

Initial repair order from current evidence:

1. Rehydrate scoped quant for `paper/1d` and `TORGHUT_SIM/15m`.
2. Settle critical `metrics_pipeline_lag_seconds` alerts for affected strategy/window pairs.
3. Refresh technicals and regime market context before news and fundamentals.
4. Restore feature coverage and drift checks for `H-MICRO-01`.
5. Close LLM governance evidence before any live micro-canary.
6. Re-run teardown-clean settlement for the current sim revision before widening sim-derived proof.

### Capital Stage Rules

`shadow_rehearsal`:

- allowed with zero notional when core dependencies and empirical jobs are fresh;
- may record partial bonds even with stale market context or empty scoped quant;
- must not claim paper eligibility.

`paper_probe`:

- requires non-empty scoped quant for the requested account/window;
- requires no matching critical pipeline-lag alert;
- allows small paper observation only after preopen or intraday Jangar receipt.

`paper_canary`:

- requires paper probe settlement, fresh context for session-critical domains, feature rows, signal continuity, and
  positive post-cost expectancy.

`live_micro_canary`:

- requires paper canary settlement, live submission policy, LLM governance completion, TCA coverage, execution
  settlement, and deployer signoff.

`live_scale`:

- requires repeated live micro-canary settlement and no unresolved rollback debt.

## Measurable Trading Hypotheses

H-SB-01, blocked decisions can predict repair value:

- Hypothesis: converting blocked decisions into partial bonds reduces time-to-paper-probe by at least `50%` compared
  with waiting for all health checks to become green.
- Measurement: count partial bonds, repair orders closed, time from blocked decision to first paper-probe bond.
- Guardrail: partial bonds never authorize notional.

H-SB-02, scoped quant freshness is the first paper unlock:

- Hypothesis: repairing scoped quant for `paper/1d` and `TORGHUT_SIM/15m` unlocks more near-term paper value than
  refreshing fundamentals first.
- Measurement: latest metrics count, critical alert count, paper-probe eligibility, and strategy/window coverage.
- Guardrail: paper stays blocked while latest metrics count is `0` or matching critical lag alerts are open.

H-SB-03, context freshness should be domain-weighted:

- Hypothesis: intraday strategies benefit more from fresh technicals and regime than from stale fundamentals.
- Measurement: `H-REV-01` rejection rate, context freshness by domain, paper-probe decision quality.
- Guardrail: stale technicals or regime block `H-REV-01` paper; stale fundamentals may remain a warning for
  zero-notional rehearsal.

H-SB-04, microstructure edge is not ready without fillability:

- Hypothesis: `H-MICRO-01` can only earn capital after feature rows, order-book liquidity, drift checks, and slippage
  estimates are current.
- Measurement: feature row count, drift check count, TCA sample count, expected cost bps, and post-cost edge.
- Guardrail: expected `10` gross bps cannot override historical high absolute slippage or missing feature coverage.

## Implementation Scope

Engineer stage:

- Add pure reducers for `SessionCapitalBond` and `ProfitRehearsalExchange`.
- Extend `/trading/status` and `/trading/profitability/runtime` with bond summaries and repair rankings.
- Build fixtures for the current state: live shadow brake, empirical jobs fresh, scoped quant empty, market context
  stale, 57 open alerts, 44 critical lag alerts, 17 blocked simple-lane decisions, 25 decisions and 0 executions.
- Do not change broker submission behavior in the first implementation.

Jangar dependency:

- Consume `session_rehearsal_id` from Jangar status when available.
- Until Jangar publishes the conductor, use a shadow adapter id and mark bonds as non-authoritative.

## Validation Gates

Local gates:

- `uv run --frozen pytest tests/test_submission_council.py tests/test_empirical_jobs.py tests/test_market_context.py`
- `uv run --frozen pytest tests/test_trading_api.py tests/test_trading_pipeline.py tests/test_verify_quant_readiness.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Behavior gates:

- Fresh empirical jobs create partial bonds, not paper eligibility, when scoped quant is empty.
- `H-REV-01` gets a context-stale denial until technicals and regime are fresh.
- `H-MICRO-01` gets a feature/drift denial until feature rows and drift checks are present.
- Critical pipeline-lag alerts block paper bonds for matching windows.
- LLM governance incomplete blocks live bonds only.
- `simple_submit_disabled` blocks live notional regardless of bond state.

Read-only runtime gates:

- `/trading/status` names the current bond state without direct database exec.
- `/trading/profitability/runtime` names the rehearsal exchange and repair ranking.
- Jangar status supplies the session receipt id before enforcement.

## Rollout Plan

Phase 0, shadow bonds:

- Add reducers and route fields behind a feature flag.
- Generate shadow bonds from current status and profitability payloads.
- Keep capital behavior unchanged.

Phase 1, authoritative Jangar receipts:

- Bind bonds to Jangar `session_rehearsal_id`.
- Keep paper/live enforcement disabled while comparing shadow bonds to current operator decisions.

Phase 2, paper probe enforcement:

- Require earned paper-probe bonds for any paper notional.
- Allow partial bonds and repair orders to continue with zero notional.

Phase 3, live micro-canary:

- Require paper settlement, TCA coverage, LLM governance completion, and live-submission policy.
- Start with max notional `0` until deployer explicitly enables the canary.

## Rollback

- Disable bond enforcement and keep bond generation visible in shadow.
- Preserve bond rows and exchange decisions for audit.
- Keep `simple_submit_disabled` and broker-side brakes intact.
- If Jangar session receipts disappear, force paper/live bonds to `denied` and keep shadow rehearsal enabled.
- If scoped quant becomes empty after paper starts, revoke paper bonds and set paper max notional to `0`.

## Risks

- Partial bonds can become vanity metrics unless they expire quickly and cite concrete products.
- Poor cost estimates can overstate post-cost edge for microstructure strategies.
- Rehearsal can hide feature pipeline failure if blocked decisions are not tied to repair orders.
- Session calendars must handle holidays and half-days before enforcement.
- Operators may want to reopen paper from empirical proof alone; this contract intentionally blocks that shortcut.

## Handoff To Engineer

Build the reducer and route fields first. Do not touch broker submission in the initial PR.

Acceptance gates:

- Fixtures reproduce the current evidence state.
- Tests prove fresh empirical jobs create partial bonds while scoped quant empty blocks paper.
- Tests prove market-context stale blocks `H-REV-01` paper and feature/drift gaps block `H-MICRO-01`.
- Tests prove live bond eligibility remains false while LLM governance is incomplete or `simple_submit_disabled` is
  active.

## Handoff To Deployer

Deploy shadow mode first. Paper or live cannot be enabled from this contract until the bond state is visible and tied
to a Jangar session receipt.

Acceptance gates:

- Paper probe requires an earned bond for the exact hypothesis, account, window, and session.
- Live micro-canary requires paper settlement, fresh live products, LLM governance completion, TCA evidence, and an
  explicit rollback target.
- Roll back enforcement immediately if an order moves without a bond id and Jangar session receipt id.
