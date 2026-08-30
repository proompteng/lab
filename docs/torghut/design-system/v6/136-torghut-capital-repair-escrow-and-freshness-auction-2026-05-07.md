# 136. Torghut Capital Repair Escrow And Freshness Auction (2026-05-07)

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

I am selecting **capital repair escrow with a freshness auction** as Torghut's next profitability architecture step.

The current Torghut system is alive and constrained for the right reasons. At `2026-05-07T04:55Z`, `/healthz` returned
`status=ok`; `/readyz` reported Postgres, ClickHouse, Alpaca, schema, universe, and empirical jobs as OK; the database
was schema-current at Alembic head `0029_whitepaper_embedding_dimension_4096`; and the live account was active. That
means the platform can run repair work.

It should not spend capital. The same readiness payload was degraded because live submission was disabled, the proof
floor was `repair_only`, capital state was `zero_notional`, all three hypotheses were either blocked or shadow, and
there were no promotion-eligible hypotheses. Jangar market context reported stale technicals, fundamentals, news, and
regime domains. Quant evidence had fresh latest metrics, but ingestion lag was `40241` seconds. Execution/TCA
settlement was stale from `2026-04-02T20:59:45.136640Z`, with `13775` orders and average absolute slippage around
`568.6` bps. Jangar dependency quorum also returned `decision=delay` because scheduled Jangar stages were stale.

The selected design treats this as a capital escrow problem, not a trading outage. Torghut should continue running
zero-notional repair jobs, but every repair job should bid against the current freshness blockers and expected unblock
value. Capital remains at zero until the highest-value blockers clear and Jangar emits current stage-trust receipts.
The tradeoff is that empirical jobs cannot directly promote paper even when they are fresh. I accept that because the
profit opportunity is not another unqualified paper run; it is clearing the stale evidence that prevents any qualified
paper run from teaching us something useful.

## Runtime Objective And Success Metrics

This contract increases profitability by making stale evidence an ordered repair market while keeping paper and live
capital escrowed.

Success means:

- Torghut can continue zero-notional repair and observation under degraded readiness.
- Paper and live notional remain `0` until Jangar stage trust, quant ingestion, market context, and TCA settlement are
  fresh.
- Repair jobs compete by expected promotion unblock value, stale-evidence severity, current market session value, and
  proof expiry.
- Empirical proof can raise repair priority but cannot bypass stale execution or market-context gates.
- The router can explain why each hypothesis is `blocked`, `repair_only`, `shadow_ready`, `paper_ready`, or
  `live_micro_ready`.
- Deployer stages get explicit widen, hold, and rollback gates.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps manifests, ClickHouse tables, or empirical artifacts.

### Cluster And Runtime Evidence

- Torghut live `torghut-00250-deployment-68df6ccfd8-nqdm2` was running with both containers ready.
- Torghut sim `torghut-sim-00350-deployment-6bdbbd5669-k9gmc` was running with both containers ready.
- Supporting Torghut services were running: Postgres, ClickHouse replicas, Keeper, TA, sim TA, options TA, options
  catalog, options enricher, websocket services, guardrail exporters, Alloy, and Symphony.
- Recent Torghut events showed new live and sim revisions becoming ready after startup/readiness probe failures during
  warmup.
- Recent events also showed Flink status external-modification warnings and repeated ClickHouse
  `MultiplePodDisruptionBudgets` warnings. These are not capital blockers by themselves, but they are rollout debt.
- The Agents service account could not list Knative services or exec into database pods, so production gates must use
  routes and projected receipts.

### Route And Control-Plane Evidence

- Torghut `/healthz` returned `status=ok`.
- Torghut `/readyz` returned `status=degraded`.
- Scheduler readiness was OK, and the scheduler was running since `2026-05-07T04:21:46.090222Z`.
- Postgres, ClickHouse, Alpaca, database, universe, empirical jobs, and DSPy runtime checks were not the immediate
  hard blockers.
- Database detail showed `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, `schema_head_delta_count=0`, and lineage warnings for migration parent
  forks around `0010` and `0015`.
- Live submission gate was not OK: reason `simple_submit_disabled`, capital stage `shadow`, configured live promotion
  false, and `promotion_eligible_total=0`.
- Alpha readiness showed `hypotheses_total=3`, `blocked=1`, `shadow=2`, `promotion_eligible_total=0`, and
  `rollback_required_total=3`.
- Dependency quorum returned `delay` because Jangar execution trust was degraded.

### Data Freshness And Profit Evidence

- The proof floor was `repair_only`; route state was `repair_only`; capital state was `zero_notional`; max notional was
  `0`.
- Proof-floor blocking reasons were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and
  `simple_submit_disabled`.
- Quant evidence was degraded but non-empty: latest metrics count `144`, latest metrics updated at
  `2026-05-07T04:55:19.536Z`, metrics pipeline lag `5` seconds, max stage lag `40241` seconds.
- Quant compute lag was `1` second and OK; ingestion lag was `40241` seconds and not OK; materialization lag was `20`
  seconds and not OK.
- Market context health was degraded. Technicals and regime freshness were about `203766` seconds, fundamentals about
  `4806744` seconds, and news about `4439930` seconds.
- Execution/TCA settlement was stale: `last_computed_at=2026-04-02T20:59:45.136640Z`, `order_count=13775`,
  `avg_abs_slippage_bps=568.6138848199565249`, and slippage guardrail `8` bps.
- Empirical proof passed for `chip-paper-microbar-composite@execution-proof` with dataset snapshot
  `torghut-chip-full-day-20260505-5e447b6d-r1`, but empirical proof did not clear current tradability.

### Source Evidence

- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines and owns much of the live decision path.
- `services/torghut/app/whitepapers/workflow.py` is `4473` lines and owns a large research-to-engineering flow.
- `services/torghut/app/trading/scheduler/governance.py` is `1917` lines and already blocks autonomy on unavailable
  Jangar universe evidence.
- `services/torghut/app/trading/scheduler/simple_pipeline.py` is `683` lines and blocks live simple submission before
  order execution when the live gate denies.
- Torghut has `141` Python test files, including coverage for readiness, policy, TCA, empirical jobs, market context,
  strategy hypotheses, and trading pipeline behavior.
- The missing source layer is a small capital repair escrow reducer that ranks repair work from existing evidence
  rather than embedding another decision path in the scheduler.

## Problem

Torghut knows why capital is blocked, but it does not yet price which blocker should be repaired first.

The current failure modes are:

1. **Fresh empirical proof competes informally with stale live evidence.** The system has fresh empirical proof, but
   TCA, market context, and quant ingestion are stale enough to invalidate capital reentry.
2. **Zero-notional work is not auctioned by expected unblock value.** Repair work can run, but the highest-value
   freshness blocker is not selected by a common scoring model.
3. **Jangar platform delay is flattened.** Torghut sees dependency quorum delay, but it needs to know whether the delay
   comes from stage trust, schedule lease debt, or consumer evidence debt.
4. **Market closed periods hide freshness debt.** Some staleness is expected outside market hours, but current evidence
   has multi-day or multi-week drift that should not be normalized as a closed-session hold.
5. **Execution proof is too old for capital sizing.** April TCA with high slippage cannot size May paper canaries.
6. **Readiness cache staleness is itself a signal.** The cache was older than its TTL during the sample, so downstream
   gates need receipt freshness, not only dependency booleans.

## Alternatives Considered

### Option A: Promote The Fresh Empirical Candidate To Paper

Pros:

- Fastest path to recent paper observations.
- Uses a fresh dataset snapshot and an eligible empirical job.
- Keeps the alpha loop active.

Cons:

- Ignores stale TCA and high slippage.
- Ignores stale market-context domains and quant ingestion.
- Ignores live submission disabled and zero promotion-eligible hypotheses.
- Ignores Jangar execution trust delay.

Decision: reject.

### Option B: Freeze All Torghut Work Until Every Gate Is Healthy

Pros:

- Strong capital safety.
- Simple incident rule.
- Avoids spending time on stale or contradictory evidence.

Cons:

- Stops useful zero-notional repair work.
- Lets empirical proof decay without converting it into repair priority.
- Produces no ordering among quant ingestion, market context, TCA, and hypothesis repair.
- Slows the path back to profitable paper canaries.

Decision: reject.

### Option C: Capital Repair Escrow With Freshness Auction

Pros:

- Keeps capital at zero while repair throughput continues.
- Turns each stale evidence source into a priced repair bid.
- Makes Jangar stage trust a first-class input to capital escrow.
- Lets empirical proof fund repair priority without authorizing capital.
- Produces deployable gates for paper and live reentry.

Cons:

- Requires a new reducer and receipt payload.
- Requires scoring calibration so repair priority is not arbitrary.
- May keep paper disabled longer than a direct empirical-promotion path.

Decision: select Option C.

## Architecture

Torghut emits one capital repair escrow receipt per account, market window, and Torghut revision.

```text
capital_repair_escrow_receipt
  receipt_id
  generated_at
  account_label
  torghut_revision
  market_window
  jangar_stage_trust_ref
  proof_floor_ref
  capital_state             # zero_notional, shadow, paper_ready, live_micro_ready
  max_notional
  blockers
  repair_bids
  selected_repairs
  fresh_until
  rollback_target
```

Each repair bid is explicit:

```text
repair_bid
  bid_id
  blocker_code
  evidence_dimension        # quant_ingestion, market_context, execution_tca, feature_rows, drift_checks, stage_trust
  current_state
  freshness_seconds
  threshold_seconds
  expected_unblock_value
  capital_effect
  max_notional              # always 0 while receipt is repair_only
  validation_command_ref
```

### Auction Scoring

Initial score:

```text
score =
  blocker_severity
  + expected_unblock_value
  + empirical_support_bonus
  + market_session_value
  - repair_cost
  - operational_risk
```

Tie-breakers:

1. Repair evidence that blocks every hypothesis.
2. Repair evidence that unlocks the closest promotion candidate.
3. Repair evidence with the shortest freshness half-life.
4. Repair evidence with bounded zero-notional validation.

### Capital States

- `zero_notional`: any hard blocker exists; only observe and repair work can run.
- `shadow`: all hard platform blockers clear, but trading proof is incomplete.
- `paper_ready`: Jangar stage trust is current, quant ingestion is fresh, market context is fresh, TCA is current, and
  at least one hypothesis has complete feature/drift proof.
- `live_micro_ready`: paper outcomes pass, slippage is inside guardrail, rollback is active, and no broker/account
  anomalies exist.

## Implementation Scope

Engineer stage should implement the minimum production slice:

- Add a capital repair escrow reducer that consumes existing proof-floor, quant, market-context, TCA, hypothesis, and
  Jangar dependency receipts.
- Add the Jangar stage-trust receipt as an optional input, defaulting to hard hold when absent for paper/live.
- Emit repair bids for quant ingestion, market context, execution TCA, feature rows, drift checks, and stage trust.
- Surface selected repair bids in `/readyz` and the trading status route without enabling new capital paths.
- Add tests for auction ranking, zero-notional enforcement, Jangar stage-trust hold, and empirical-proof non-bypass.

Out of scope for the first implementation:

- Enabling live submission.
- Changing broker credentials or account configuration.
- Writing ClickHouse or Postgres repair data outside the normal application paths.
- Replacing the existing proof-floor reducer.

## Validation Gates

Local validation:

- `uv sync --frozen --extra dev`
- `uv run --frozen pytest tests/test_trading_scheduler_safety.py tests/test_profitability_proof_floor.py`
- `uv run --frozen pytest tests/test_policy_checks.py tests/test_tca_adaptive_policy.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Cluster validation after deploy:

- `curl -sS -H 'Host: torghut.torghut.svc.cluster.local' http://knative-local-gateway.istio-system.svc.cluster.local/readyz | jq '.proof_floor,.capital_repair_escrow'`
- `curl -sS http://jangar.jangar/api/torghut/market-context/health | jq '.health.overallState,.health.domainHealth'`
- `curl -sS http://jangar.jangar/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF\\&window=15m | jq '.status,.stages'`
- Confirm max notional remains `0` while any repair bid has a hard blocker.
- Confirm the first selected repair bid matches the largest fresh evidence blocker, not the newest empirical proof.

## Rollout Plan

1. Ship receipt generation in observe-only mode.
2. Compare selected repair bids with current proof-floor repair ladder for one full market session.
3. Let zero-notional scheduled repair jobs consume the selected repair bid.
4. Require current Jangar stage trust before paper readiness can become true.
5. Gate paper canary on current quant ingestion, market context, and TCA receipts.
6. Gate live micro only after paper outcome receipts and rollback target are proven.

## Rollback Plan

- Disable capital repair escrow receipt consumption and fall back to the existing proof-floor reducer.
- Keep max notional at `0` while any Jangar stage-trust or proof-floor receipt is missing.
- Continue publishing repair bid diagnostics in observe-only mode for post-incident analysis.
- Revert the Torghut image through GitOps if receipt generation affects readiness latency or route availability.

## Risks And Mitigations

- **Bad repair scoring:** start observe-only and compare against manual repair priority before consumers act on it.
- **Stale Jangar input:** require receipt expiry and reason codes; absence means paper/live hold.
- **Market-closed false alarms:** encode expected closed-session holds separately from multi-day freshness debt.
- **Scheduler complexity:** keep the reducer separate from order submission and return max notional `0` for all repairs.
- **Empirical proof overreach:** enforce tests that fresh empirical proof cannot bypass TCA, market context, or Jangar
  stage trust.

## Handoff To Engineer

Implement the repair escrow as a reducer and receipt, not as another branch inside the order scheduler. Use existing
proof-floor, quant, market-context, TCA, hypothesis, and Jangar dependency payloads. The first production behavior is
diagnostic plus zero-notional repair selection. Paper/live capital stays held.

## Handoff To Deployer

Roll this out only after the Jangar stage-trust receipt exists or is explicitly absent and treated as a hold. Verify the
receipt on `/readyz`, confirm max notional is `0`, and confirm selected repair bids line up with live evidence. Do not
enable paper canaries until quant ingestion, market context, TCA, and Jangar stage trust are fresh in the same window.
