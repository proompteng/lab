# 108. Torghut Proof Repair Closure Receipts And Profit Settlement (2026-05-06)

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

I am choosing **proof repair closure receipts with profit settlement** for Torghut.

The current live system is doing useful repair work, but repair completion and profit proof are still separate facts.
During this assessment Torghut rolled to `torghut-00232`, ran database migrations successfully, completed an empirical
jobs backfill job, and kept Postgres, ClickHouse, Alpaca, schema, and universe checks healthy. Live readiness still
returned HTTP 503. Jangar dependency quorum still blocked on `empirical_jobs_degraded`. Runtime profitability still
showed 8 decisions, 0 executions, and 0 TCA samples in the 72-hour window. The latest decisions remained pre-submit
rejects from May 4 for insufficient buying power.

Torghut should therefore stop treating repair job completion as the important boundary. The important boundary is a
typed receipt that says which proof gap was retired, which evidence changed, which capital settlement state is now
legal, and when that claim expires. The receipt becomes the compact input Jangar consumes through the companion repair
closure arbiter.

The tradeoff is that repair lanes will have to write evidence even when they appear successful. I accept that. A trading
system that cannot prove its repair closed the gap is not ready to spend more capital.

## Read-Only Evidence Snapshot

No Kubernetes resources, database records, broker settings, trading settings, or runtime objects were mutated during
this assessment.

### Cluster And Runtime Evidence

- Torghut live revision `torghut-00232` and simulation revision `torghut-sim-00313` were created during the assessment.
- `torghut-00232-deployment` and `torghut-sim-00313-deployment` reached `2/2 Running`; the previous live revision
  `torghut-00231` was terminating.
- Torghut events showed `torghut-db-migrations` completed, `torghut-empirical-jobs-backfill` completed, whitepaper
  bootstrap jobs completed, and transient startup/readiness probe failures during rollout.
- `/healthz` returned OK.
- `/readyz` returned HTTP 503 while scheduler, Postgres, ClickHouse, Alpaca, database schema, and universe checks were
  healthy.
- `/trading/health` returned HTTP 503 with the same live-submission block.
- `/trading/status` reported active revision `torghut-00232`, mode `live`, `pipeline_mode=simple`,
  `execution_lane=simple`, `kill_switch_enabled=false`, `capital_stage=shadow`, and live submission blocked by
  `simple_submit_disabled`.
- The same status reported `TRADING_AUTONOMY_ENABLED=false`, `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`,
  `configured_live_promotion=false`, and `orders_submitted_total=0`.

### Database And Profit Evidence

- Direct CNPG cluster reads were forbidden to `system:serviceaccount:agents:agents-sa`; this pass used service-owned
  read-only database projections.
- `/db-check` returned schema current at Alembic head `0029_whitepaper_embedding_dimension_4096`, current and expected
  heads aligned, one graph branch, no duplicate revisions, no orphan parents, and known parent-fork warnings at
  migrations `0010` and `0015`.
- Account-scope checks were marked ready, with a warning that account-scope checks are bypassed when multi-account
  trading is disabled.
- Jangar dependency quorum still returned `block` for `empirical_jobs_degraded` after the empirical backfill job
  completed.
- Empirical jobs remained stale from `2026-03-21T09:03:22Z` for `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`.
- Quant evidence remained informational rather than required: `required=false`, `status=not_required`, and
  `reason=quant_health_not_configured` for account `PA3SX7FYNUTF` and window `15m`.
- Signal continuity was market-closed, not capital-ready: `last_state=expected_market_closed_staleness`,
  `last_reason=cursor_tail_stable`, `signal_lag_seconds=36487`, and `actionable=false`.
- Hypothesis state remained non-promotable: three hypotheses total, two shadow, one blocked, zero promotion eligible,
  three rollback required, and dependency quorum `block`.
- Runtime profitability showed an active 72-hour window with 8 decisions, 0 executions, and 0 TCA samples.
- Latest decisions were rejected before submit because target notional around `157950.10` exceeded buying power around
  `141543.88`.
- TCA projection retained 13,775 historical rows, but `last_computed_at=2026-04-02T20:59:45Z`,
  `expected_shortfall_sample_count=0`, and `expected_shortfall_coverage=0`.

### Source Evidence

- `services/torghut/app/trading/submission_council.py` is the correct reducer boundary for live submission gate,
  dependency quorum, quant evidence, empirical readiness, and capital stage.
- `services/torghut/app/main.py` exposes readiness, trading status, decisions, executions, TCA, and runtime
  profitability. It should publish reduced receipt state, not grow another local interpretation layer.
- `services/torghut/app/trading/scheduler/pipeline.py` consumes submission gates and owns the large decision path.
  Receipt enforcement should feed it through a small budget/settlement adapter.
- Existing tests cover empirical jobs, submission council, trading scheduler safety, risk, TCA, runtime profitability,
  hypotheses, metrics, and order idempotency.
- The missing regression is closure-specific: a completed empirical backfill job with unchanged stale empirical
  projection must keep `capital_settlement=blocked` and emit a rejected or pending closure receipt.

## Problem

Torghut has repair activity without proof finality.

The system currently tells us several true facts:

1. A repair job completed.
2. Database schema is current.
3. Service dependencies are healthy.
4. Live submission is disabled.
5. Empirical jobs remain stale.
6. Hypotheses are not promotion eligible.
7. Recent decisions did not execute and old TCA proof is stale.

The problem is not a lack of facts. The problem is that facts are not reduced into closure. Engineers need to know
whether a proof gap moved from open to repaired, and deployers need to know whether that repair changes capital state.
Jangar needs one compact receipt it can consume without parsing every Torghut route.

## Alternatives Considered

### Option A: Let Readiness Decide Repair Closure

Pros:

- Easy to observe.
- Already exposed through `/readyz` and `/trading/health`.
- Catches live-submission blocks.

Cons:

- Readiness stays 503 while many dependencies are healthy, so it does not explain which repair retired which gap.
- Readiness can become healthy before proof is capital-authoritative.
- It cannot distinguish empirical replay, quant republish, TCA refresh, or hypothesis requalification.

Decision: reject. Readiness is an operator surface, not a proof ledger.

### Option B: Let The Profit Repair ROI Ledger Be The Final Source

Pros:

- Builds on the existing ROI-ledger direction.
- Gives repair work an owner, expected value, cost, and expiry.
- Keeps capital work tied to economics.

Cons:

- A repair lane can be accepted as a plan without proving the after-state changed.
- It does not by itself give Jangar before/after evidence refs.
- It still needs a receipt boundary between "repair should happen" and "repair closed the gap."

Decision: keep the ROI ledger as the planning surface, but do not make it finality.

### Option C: Emit Proof Repair Closure Receipts

Pros:

- Converts after-state evidence into a typed contract.
- Lets Jangar keep material actions blocked when repair execution succeeds but proof remains stale.
- Gives Torghut a narrow way to publish capital settlement without exposing route internals.
- Supports regression tests and expiry.
- Keeps repair-only lanes open while preventing accidental paper/live promotion.

Cons:

- Requires new projection code.
- Requires producers to gather before/after evidence.
- Adds one more state to the deployer checklist.

Decision: select Option C.

## Chosen Architecture

Torghut should emit `proof_repair_closure_receipt` records for every proof gap that can affect paper or live capital.

```text
proof_repair_closure_receipt
  receipt_id
  account
  strategy_family
  hypothesis_id
  proof_gap
  repair_lane
  repair_run_ref
  before_state
  after_state
  retired_reason_codes[]
  remaining_reason_codes[]
  capital_settlement_before       # blocked, repair_only, paper_candidate, live_candidate
  capital_settlement_after
  evidence_refs[]
  observed_sample_count
  expected_net_bps
  max_drawdown_bps
  closure_decision                # accepted, rejected, partial, expired
  fresh_until
```

Initial receipt types:

- `empirical_replay_closure`: four required empirical jobs are fresh, truthful, promotion-eligible, and from one coherent
  candidate/dataset lineage.
- `quant_republish_closure`: latest account/window metrics are non-empty, stage rows are present, and quant evidence is
  required for the target action class.
- `submission_gate_rehearsal_closure`: live submission remains disabled unless explicitly intended, rehearsal proves no
  accidental broker submissions, and readiness explains the intended capital state.
- `hypothesis_requalification_closure`: at least one hypothesis has fresh proof, positive expected net edge after cost,
  bounded drawdown, and no rollback-required state for the requested action class.
- `tca_settlement_closure`: TCA computation is current, expected-shortfall samples are non-zero, and calibration
  coverage meets the hypothesis threshold.
- `options_feature_bootstrap_closure`: options bars, options features, and quote-quality proof are non-empty and fresh
  before any options-adjacent capital state can widen.

Capital settlement rules:

- If live submission is disabled, live capital is `blocked` regardless of other proof.
- If quant evidence is not required or latest account/window metrics are empty, paper and live promotion are blocked.
- If empirical jobs are stale, promotion is blocked and empirical repair is `repair_only`.
- If promotion eligibility is zero, paper and live promotion are blocked even when service dependencies are healthy.
- If TCA expected-shortfall coverage is zero, scaling is blocked and live micro-canary requires explicit waiver plus
  rollback proof.
- If a receipt expires or is contradicted by later projections, the proof gap reopens.

For the current evidence, Torghut should emit:

```text
empirical_replay_closure           rejected or receipt_pending
quant_republish_closure            open
submission_gate_rehearsal_closure  open
hypothesis_requalification_closure open
tca_settlement_closure             open

capital_settlement                 blocked
repair_lanes                       empirical_replay, quant_republish, submission_gate_rehearsal,
                                   hypothesis_requalification, tca_settlement
```

## Measurable Trading Hypotheses

The next implementation stage should use these repair-to-profit hypotheses:

- Empirical replay closure retires `empirical_jobs_degraded` within 24 hours and flips Jangar dependency quorum from
  `block` to non-blocking for the empirical segment.
- Quant republish closure makes account/window quant evidence required and fresh for `PA3SX7FYNUTF` before paper
  capital is considered.
- Submission rehearsal keeps live broker submissions at zero until an explicit promotion while making readiness explain
  the intended disabled state.
- Hypothesis requalification produces at least one paper candidate with expected net edge above 6 bps, max drawdown under
  the hypothesis limit, and rollback-required false.
- TCA settlement raises expected-shortfall coverage from 0 to at least 90 percent before live scale is considered.
- Reject-drain repair reduces `insufficient_buying_power` pre-submit rejects below 1 percent by clamping target notional
  before persistence.

## Engineer Handoff

Implement closure receipts before changing capital behavior.

Required slices:

- Add a pure Torghut receipt reducer near `submission_council.py`.
- Add a projection endpoint or status section that publishes reduced closure receipts for Jangar.
- Connect empirical job status, quant evidence, live submission gate, hypothesis summary, runtime profitability, and TCA
  summary into the receipt reducer.
- Add tests for the current evidence fixture: completed empirical backfill with stale empirical status emits
  `empirical_replay_closure=rejected` or `receipt_pending`, not accepted.
- Add tests proving service dependencies healthy plus live submission disabled keeps `capital_settlement=blocked`.
- Add tests proving zero promotion eligibility blocks paper and live promotion.
- Add tests proving expected-shortfall coverage zero blocks live scale.

Acceptance gates:

- Every receipt has before and after state.
- Accepted receipts must retire at least one reason code and leave no contradiction in the source projection.
- Missing or expired receipts are treated as open proof gaps.
- Jangar can consume the reduced receipt payload without calling Torghut decisions, executions, or TCA detail routes.

## Deployer Handoff

Roll out in four stages:

1. `observe`: publish receipts and compare them with existing readiness/status.
2. `repair_only`: allow empirical replay, quant republish, submission rehearsal, hypothesis requalification, and TCA
   settlement lanes while capital stays blocked.
3. `paper_candidate`: allow paper only after empirical, quant, hypothesis, and TCA receipts are accepted for the target
   account/window.
4. `live_candidate`: allow live candidate review only after Jangar material-action settlement accepts the closure
   receipts and live submission is intentionally enabled.

Deployment gates:

- `/db-check` remains schema-current with no missing or unexpected heads.
- `/trading/status` publishes active revision, capital settlement, closure receipts, and no promotion wider than the
  accepted receipts.
- Jangar dependency quorum no longer blocks the relevant empirical segment before paper/live promotion.
- Runtime profitability has fresh decisions, non-zero execution or paper-settlement evidence when required, and no new
  unexplained pre-submit rejection spike.

Rollback:

- Expire or reject the affected receipt.
- Return capital settlement to `blocked` or `repair_only`.
- Keep receipt history for diagnosis.
- Do not enable live submission as a rollback action.

## Validation Plan

- `bunx oxfmt --check docs/agents/designs/104-jangar-repair-closure-receipts-and-settlement-finality-2026-05-06.md
docs/torghut/design-system/v6/108-torghut-proof-repair-closure-receipts-and-profit-settlement-2026-05-06.md
docs/torghut/design-system/v6/index.md`
- Future engineer test: `uv run --frozen pytest services/torghut/tests/test_submission_council.py -k closure`
- Future engineer test: `uv run --frozen pytest services/torghut/tests/test_empirical_jobs.py -k closure`
- Future engineer test: `uv run --frozen pytest services/torghut/tests/test_runtime_profitability.py -k closure`
- Read-only smoke: `curl http://torghut.torghut.svc.cluster.local/readyz`
- Read-only smoke: `curl http://torghut.torghut.svc.cluster.local/trading/status`
- Read-only smoke: `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`

## Risks

- Receipt producers can over-claim closure. The reducer must reject accepted receipts when source projection still shows
  the retired reason.
- Closure receipts can add storage and status noise. Start with only the five capital-affecting proof gaps named above.
- Expected edge can become decorative. Accepted repair receipts must include observed samples, expiry, and drawdown
  limits.
- Direct DB access is unavailable in the current runtime. Service projections are sufficient for the design pass, but a
  deployer-grade read-only database path is still needed for incident response.
