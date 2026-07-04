# 183. Torghut Receipt-Settled Capital Reentry Cohorts (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut profitability, routeable post-cost evidence, receipt settlement, paper canary readiness, capital safety,
validation, rollout, rollback, and implementation handoff.

Companion Jangar contract:

- `docs/agents/designs/179-jangar-controller-witness-stability-escrow-and-capital-reentry-backpressure-2026-05-08.md`

Extends:

- `182-torghut-route-proven-profit-receipts-and-consumer-evidence-canary-2026-05-08.md`
- `181-torghut-quality-adjusted-profit-frontier-and-hypothesis-escrow-2026-05-08.md`
- `169-torghut-route-reacquisition-board-and-profit-repair-packets-2026-05-07.md`
- `docs/agents/designs/178-jangar-source-serving-parity-escrow-and-route-independent-launch-passports-2026-05-08.md`

## Decision

I am selecting **receipt-settled capital reentry cohorts** as Torghut's next profitability architecture step.

The previous route-parity failure has been reduced. On `2026-05-08T08:26Z`, live Torghut returned HTTP 200 from
`/trading/consumer-evidence` with a current `torghut.consumer-evidence-receipt.v1` receipt for
`chip-paper-microbar-composite@execution-proof`. Jangar consumed the receipt and marked Torghut consumer evidence
`current`. That is meaningful progress: the capital proof now crosses the Jangar boundary instead of living only
inside `/trading/status`.

The receipt correctly keeps capital closed. Live `/readyz` returned HTTP 503 `degraded` while dependencies were
reachable: Postgres, ClickHouse, Alpaca, schema lineage, empirical jobs, and quant evidence all reported usable
runtime status. The blockers are profitability and admission blockers, not service liveness blockers:
`forecast_registry_degraded`, `simple_submit_disabled`, and `hypothesis_not_promotion_eligible`. The proof floor
is `repair_only`, capital state is `zero_notional`, and the live submission gate is closed.

The route book now tells us where to spend the next engineering dollar. AAPL is a probing candidate with TCA evidence
but no market-context, quant, or alpha receipts attached. NVDA, AMD, INTC, and AVGO are blocked by route TCA universe
exclusions. AMZN, GOOGL, and ORCL are missing execution TCA. The repair book's expected unblock value is 14, but the
work is not yet grouped into capital-reentry cohorts with an explicit paper canary sequence.

The selected design turns the current receipt, proof floor, TCA book, forecast registry, alpha readiness, and Jangar
material verdict into a cohort ledger. Torghut can run zero-notional repair immediately, but it may only request paper
canary authority when a cohort has a current consumer receipt, fresh market context, scoped quant evidence, route TCA,
alpha readiness, forecast registry eligibility, and Jangar controller-witness stability. The tradeoff is that AAPL may
wait even though it is the best current route candidate. I accept that. The first paper canary should prove the
settlement process, not just chase the nearest symbol.

## Current Evidence

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests, trading
flags, or broker state.

### Cluster And Runtime

- Argo CD reported `torghut`, `symphony-torghut`, and `jangar` `Synced` and `Healthy` at current `main`.
- Torghut live pod `torghut-00302-deployment-6ddbcf6f46-nqcfk` was `2/2 Running`.
- Torghut sim pod `torghut-sim-00400-deployment-7f44b8675c-542mr` was `2/2 Running`; the earlier sim ImagePullBackOff
  from the shared soak has cleared.
- Torghut ClickHouse, Keeper, Postgres, WebSocket, TA, options TA, options catalog, and options enricher pods were
  running.
- RBAC blocked `ksvc` and Argo Rollouts reads in namespace `torghut`, so rollout details were taken from Argo
  Application status, pods, services, events, and service endpoints.
- Recent Torghut events showed the DB migration job completing, whitepaper and empirical backfill jobs completing, and
  repeated ClickHouse PDB overlap warnings. A historical whitepaper autoresearch pod remained `Error`, outside the
  live trading gate.

### Service And Proof Surface

- `/healthz` returned HTTP 200.
- `/readyz` returned HTTP 503 `degraded`, with Postgres, ClickHouse, Alpaca, database schema, empirical jobs, and
  quant evidence usable, but proof floor `repair_only` and live submission closed.
- `/db-check` returned HTTP 200 with Alembic head `0029_whitepaper_embedding_dimension_4096`, schema current, lineage
  ready, and parent-fork warnings for historical branches.
- `/trading/consumer-evidence` returned HTTP 200 and included:
  - `receipt_id=torghut-consumer-evidence:cbfabfe10aca7100` in the direct sample.
  - `candidate_id=chip-paper-microbar-composite@execution-proof`.
  - `dataset_snapshot_ref=torghut-chip-full-day-20260505-4c330ce9-r1`.
  - `empirical_jobs_state=healthy`.
  - `forecast_registry_state=degraded`.
  - `tca_state=pass`.
  - `paper_readiness_state=blocked`.
  - `live_readiness_state=blocked`.
  - `max_notional=0`.
- Jangar consumed a current Torghut receipt and still held paper/live action classes, which is the right safety state.

### Data Quality And Freshness

- Live proof floor had `route_state=repair_only`, `capital_state=zero_notional`, and blockers
  `hypothesis_not_promotion_eligible` and `simple_submit_disabled`.
- Route reacquisition showed 8 scoped symbols, 0 routeable symbols, 1 probing symbol, 4 blocked symbols, 3 missing
  symbols, and 7 repair candidates.
- AAPL was the only probing candidate. NVDA, AMD, INTC, and AVGO were blocked by
  `execution_tca_route_universe_exclusions_applied`. AMZN, GOOGL, and ORCL were missing execution TCA.
- Execution TCA summarized 7,334 orders, 7,245 filled executions, average absolute slippage about 13.82 bps, and a
  route slippage guardrail of 12 bps.
- Jangar quant health for account `PA3SX7FYNUTF` and window `15m` returned `ok=true`, `status=ok`, 144 latest metrics,
  latest update `2026-05-08T08:26:00.374Z`, and pipeline lag 71 seconds, but no recent stage rows.
- AAPL market context had quality score `0.6825`; fundamentals were `ok`, while technicals, news, and regime were
  stale in the closed-market window.
- Direct row-level Postgres and ClickHouse reads were unavailable from this service account: `kubectl cnpg psql`
  failed on `pods/exec` RBAC, local `psql` was not installed, Kubernetes secrets were forbidden, and ClickHouse HTTP
  required credentials. The design therefore treats typed service receipts as the deployer-readable data boundary.

### Source And Test Surface

- `services/torghut/app/main.py` is 4,366 lines and now defines `/trading/consumer-evidence`, ready/status proof floor
  payloads, route reacquisition board payloads, and live submission gate payloads.
- `services/torghut/app/trading/proof_floor.py` is 754 lines and owns the proof-floor receipt.
- `services/torghut/app/trading/consumer_evidence.py` is 208 lines and builds stable consumer evidence receipts.
- `services/torghut/app/trading/submission_council.py` is 1,202 lines and remains a high-risk capital gate module.
- Existing tests cover consumer evidence, proof floor behavior, route reacquisition, readiness verification, trading
  API payloads, and Jangar consumer evidence parsing.
- The missing cross-plane test is a release gate that proves: current Torghut receipt plus degraded forecast/alpha
  evidence still yields `paper_canary=hold`, `live_micro_canary=block`, and `max_notional=0`.

## Problem

Torghut is no longer blocked on a missing consumer route. It is blocked on settlement sequence.

The failure modes are:

1. A current receipt can be mistaken for capital readiness even when it says `max_notional=0`.
2. AAPL has partial route evidence but no settled cohort tying market context, quant evidence, alpha readiness,
   forecast eligibility, and Jangar material verdicts together.
3. Route repair candidates are ranked, but paper canary admission is not expressed as cohort states.
4. Forecast registry degradation is a capital blocker but not yet a quantified repair cohort with an acceptance gate.
5. Direct database inspection is not guaranteed for deployers, so the authoritative runtime boundary must be typed
   receipts and status surfaces.
6. `simple_submit_disabled` is doing the last safety work; it should remain closed until the cohort ledger proves why
   a paper canary can open.

## Alternatives Considered

### Option A: Promote AAPL Directly To Paper Canary Once Forecast Registry Recovers

Advantages:

- Fastest path to one paper candidate.
- Uses the existing best route candidate.
- Easy to measure routeability improvement.

Disadvantages:

- Skips explicit settlement for market context, quant stage evidence, and alpha readiness.
- Lets one symbol become a special case.
- Does not create a reusable path for NVDA, AMD, or missing TCA symbols.

Decision: reject as the primary architecture. AAPL should be the first cohort, not a bypass.

### Option B: Keep All Capital Closed Until Every Symbol Has TCA And Fresh Context

Advantages:

- Simple safety rule.
- Avoids per-symbol partial readiness.
- Prevents capital from following a weak route universe.

Disadvantages:

- Delays learning from the one useful probing candidate.
- Treats missing AMZN/GOOGL/ORCL TCA the same as AAPL receipt settlement.
- Reduces future option value by forcing all repairs into one global gate.

Decision: reject. It is safe but too blunt for a profitability system.

### Option C: Receipt-Settled Capital Reentry Cohorts

Advantages:

- Converts the current receipt into explicit cohort states without opening notional.
- Lets AAPL prove the settlement path while the rest of the route universe repairs in parallel.
- Maps each repair to a business metric: routeable candidates, stale evidence rate, TCA quality, and capital safety.
- Gives Jangar one compact receipt to cite for paper/live verdicts.

Disadvantages:

- Adds a cohort reducer and status payload.
- Requires careful coordination with Jangar controller-witness stability.
- Paper canary remains held until all cohort receipts settle, even if individual evidence looks promising.

Decision: select Option C.

## Architecture

Torghut adds a `capital_reentry_cohort_ledger` as a derived runtime receipt:

```text
capital_reentry_cohort_ledger
  ledger_id
  generated_at
  account_label
  trading_mode
  torghut_revision
  jangar_material_verdict_ref
  consumer_evidence_receipt_id
  proof_floor_ref
  cohorts[]
  aggregate_state
  rollback_target
```

Each cohort is scoped to a repair and capital transition:

```text
capital_reentry_cohort
  cohort_id
  symbol_set
  cohort_class             # receipt_settlement | tca_repair | missing_tca_probe | forecast_registry | alpha_readiness
  current_state            # observe | repair | paper_candidate | hold | block
  max_notional
  expected_unblock_value
  required_receipts
  blocking_reason_codes
  metric_bindings
  next_action
```

Initial cohorts:

- `aapl_receipt_settlement`: AAPL only; settle market context, quant stage, alpha readiness, forecast eligibility, and
  Jangar paper verdict before paper canary.
- `high_activity_tca_repair`: NVDA, AMD, AVGO, and INTC; repair slippage and route-universe exclusions before any
  candidate state.
- `missing_tca_probe`: AMZN, GOOGL, and ORCL; create simulation or paperless TCA evidence before route ranking.
- `forecast_registry_repair`: restore eligible forecast registry state for the active candidate receipt.
- `alpha_readiness_repair`: clear blocked and shadow hypotheses into a promotion-eligible paper candidate.

Rules:

- Every cohort starts with `max_notional=0`.
- `paper_candidate` requires current consumer evidence, proof floor not `repair_only`, Jangar paper verdict not held,
  forecast registry not degraded, alpha readiness promotion eligible, and route TCA within guardrails.
- `live_micro_canary` is out of scope for the first implementation and remains blocked.
- Missing direct DB access cannot block deployer validation if typed receipts are present and fresh; it must be
  recorded as an observer limitation.

## Measurable Hypotheses

- H1: Settling the AAPL receipt cohort increases `routeable_candidate_count` from 0 to at least 1 paper candidate
  without changing live notional.
- H2: Repairing high-activity TCA cohorts reduces `zero_notional_or_stale_evidence_rate` by converting at least two of
  NVDA, AMD, AVGO, and INTC from blocked to observed or probing.
- H3: Filling missing TCA for AMZN, GOOGL, and ORCL improves `fill_tca_or_slippage_quality` coverage without granting
  capital authority.
- H4: Restoring forecast registry eligibility removes `forecast_registry_degraded` from the consumer receipt and
  Jangar paper-canary blockers.
- H5: Live capital remains blocked until paper settlement proves positive post-cost behavior; this protects
  `capital_gate_safety` while building toward `post_cost_daily_net_pnl`.

## Implementation Scope

Engineer stage should implement:

- A pure cohort reducer near the proof floor and route reacquisition code.
- Additive `capital_reentry_cohort_ledger` in `/trading/status`, `/readyz`, and `/trading/consumer-evidence`.
- A release-gate script or test fixture that asserts current receipt plus forecast/alpha blockers keeps paper held and
  live blocked.
- Jangar consumer mapping that cites cohort ids in material action verdict evidence refs.
- Tests for AAPL receipt settlement, TCA repair cohorts, missing TCA cohorts, forecast registry repair, alpha readiness
  repair, and no-notional safety.

## Validation Gates

- `routeable_candidate_count`: at least one paper candidate only after the AAPL cohort settles all required receipts.
- `zero_notional_or_stale_evidence_rate`: all unsettled cohorts emit `max_notional=0` and explicit stale/missing
  reasons.
- `fill_tca_or_slippage_quality`: high-activity and missing-TCA cohorts must publish TCA coverage and slippage state.
- `capital_gate_safety`: `simple_submit_disabled` remains effective until paper canary is explicitly allowed by the
  cohort ledger and Jangar material verdict.
- `post_cost_daily_net_pnl`: no daily PnL improvement is claimed until paper canary produces routeable post-cost
  evidence; before that, the improved metric is candidate readiness, not revenue.

Local checks:

- `uv sync --frozen --extra dev`
- `uv run --frozen pytest tests/test_consumer_evidence.py tests/test_profitability_proof_floor.py tests/test_route_reacquisition.py tests/test_verify_trading_readiness.py`
- `bun run --filter @proompteng/jangar test -- control-plane-torghut-consumer-evidence`
- `bunx oxfmt --check docs/torghut/design-system/v6/183-torghut-receipt-settled-capital-reentry-cohorts-2026-05-08.md`

Cluster checks after rollout:

- `/trading/consumer-evidence` returns a current receipt and cohort ledger with `max_notional=0` while blockers remain.
- `/readyz` can be degraded for capital reasons while dependency details remain explicit.
- Jangar material action verdicts cite cohort ids for `paper_canary`, `live_micro_canary`, and `live_scale`.
- A paper canary cannot open unless the Jangar controller-witness stability escrow is current.

## Rollout

1. Ship cohort ledger in observe mode with no capital effect.
2. Add Jangar evidence refs but keep material verdict decisions unchanged.
3. Enable paper-canary eligibility for the AAPL cohort only after one full market session of fresh receipts.
4. Add high-activity TCA repairs and missing-TCA probes as zero-notional work.
5. Keep live micro and live scale blocked until paper canary produces post-cost evidence and rollback receipts.

## Rollback

- Remove cohort ledger consumption from Jangar and fall back to the existing consumer evidence receipt.
- Keep `/trading/consumer-evidence` available because it is now the working route boundary.
- Set every cohort to `hold` with `max_notional=0` if reducer output is missing, stale, or schema-incompatible.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` and live submission blocked throughout rollback.

## Risks

- The first AAPL cohort could overfit to one symbol. Mitigation: paper canary is a settlement proof, not live capital,
  and high-activity TCA cohorts proceed separately.
- Forecast registry repair could look complete without alpha readiness. Mitigation: both receipts are required for
  `paper_candidate`.
- Direct DB access may remain unavailable to deployers. Mitigation: typed receipts, `/db-check`, and Jangar verdicts
  become the validation boundary.
- The cohort payload could bloat status responses. Mitigation: keep cohort entries compact and expose detailed repair
  packets only behind a bounded evidence route.

## Handoff

The next bounded implementation milestone is the observe-mode cohort reducer plus tests proving all unsettled cohorts
remain zero-notional. The smallest blocker preventing revenue impact is not service liveness; it is the missing
receipt-settled path from AAPL's probing route evidence to a paper canary that Jangar can admit without weakening
capital safety.

## Implementation Note

PR implementation adds the observe-mode `capital_reentry_cohort_ledger` runtime projection to Torghut status,
readiness, health, and consumer-evidence payloads. Jangar consumes the ledger id and cohort ids as evidence refs for
paper/live material-action verdicts while keeping the existing decisions conservative. This closes the first engineer
stage without changing live capital defaults: all initial cohorts still emit `max_notional=0`, and rollback remains a
PR revert or disabling Jangar cohort consumption.
