# 141. Torghut Watch-Debt Profit Repair Market And Capital Reentry Gates (2026-05-07)

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

I am selecting a **watch-debt fed profit repair market with explicit capital reentry gates** for Torghut.

Torghut is not missing all evidence. The global quant health route is fresh, the latest-store has thousands of metrics,
and empirical jobs are current. The blockers are concentrated: Jangar watch debt is degraded, forecast proof is empty,
market context is stale or timing out for sampled symbols, and account/window quant alerts remain open. A binary capital
freeze is safe but leaves no ranked path back to profitable paper or live trading. A local Torghut-only repair loop would
miss Jangar rollout, watch, and endpoint parity risk. The selected design uses Jangar watch-debt leases as the upstream
admission contract and turns Torghut proof gaps into measurable zero-notional repair bids.

The tradeoff is that paper and live capital will wait for more proof. I accept that. The next six months need fewer
accidental green lights and more capital-efficient proof repair. Torghut should spend compute on the proof gaps most
likely to restore profitable, controlled canaries.

## Runtime Objective And Success Metrics

This contract increases profitability by making proof repair measurable before capital is released.

Success means:

- `torghut_observe` remains available while Jangar watch debt or Torghut proof debt is present.
- Repair work has `max_notional=0` and cites a Jangar repair lease or a Torghut proof-repair bid.
- Paper canaries require a clean Jangar watch-debt epoch, current endpoint parity, fresh market context, non-empty
  forecast proof, and no critical account/window quant alerts.
- Live micro canaries require paper settlement, bounded TCA, no critical alerts, and a current capital reentry receipt.
- Live scale requires live micro settlement and explicit operator approval or an approved automated escalation policy.
- Every promoted hypothesis declares expected edge, evidence cost, drawdown guard, stale-proof exit, and rollback path.

## Evidence Snapshot

All evidence was collected through read-only service routes, source inspection, and read-only Kubernetes commands.

### Jangar Control-Plane Evidence

- Jangar DB status was healthy with `28/28` registered/applied Kysely migrations and latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar rollout health was healthy for `agents` and `agents-controllers`.
- Jangar watch reliability was degraded in a 15-minute window: `1268` events, `14` errors, and `17` restarts.
- AgentRun ingestion was `unknown` from the serving process with message `agents controller not started`.
- Dependency quorum was `block` because of `watch_reliability_blocked`.
- Serving remained available: `/health` and `/ready` both returned HTTP 200 during the assessment.

### Torghut Data Evidence

- Global quant health returned `status=ok`, `latestMetricsCount=4032`, and `metricsPipelineLagSeconds=2`.
- Account/window quant health for strategy `db327e20-4d37-45f3-bf18-5c51e844de31`, account `PA3SX7FYNUTF`, and
  windows `1m` and `5m` returned `status=ok` outside market hours, but latest metrics lag was `144` and `138` seconds,
  and no pipeline stages appeared in the 60-second lookback.
- `/api/torghut/trading/control-plane/quant/alerts?state=open` returned `36` open alerts:
  - `23` critical `metrics_pipeline_lag_seconds`;
  - `12` warning `ta_freshness_seconds`;
  - `1` warning `sharpe_annualized`.
- The oldest open TA freshness alerts in the sample were opened on `2026-04-09`, which means stale proof can persist
  while global latest metrics look fresh.
- `/api/torghut/market-context/health?symbol=NVDA` returned `overallState=degraded`, with technicals, fundamentals,
  news, and regime stale.
- `/api/torghut/market-context/health?symbol=AAPL` timed out at 10 seconds from this runtime.
- Jangar empirical services reported `forecast.status=degraded`, `message=registry_empty`, and no eligible models.
  Empirical jobs were healthy and authoritative.

### Source Evidence

- `services/jangar/src/server/control-plane-action-clock.ts` already turns empirical proof debt into Torghut capital
  holds through reasons such as `forecast_service_degraded`.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` maps action SLO budgets, action clocks, and
  dependency quorum into final action receipts.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` is the bounded Jangar store boundary for latest metrics,
  series reads, alerts, and pipeline health.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` treats account/window pipeline health
  as scoped only when both account and window are provided. The global route can be fresh while account/window debt
  remains open.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines, so the first enforcement point should be a
  small Jangar/Torghut receipt contract rather than more scheduler branching.

## Problem

Torghut needs a profit-aware way to repair proof debt before it gets capital.

The current gates correctly hold paper and live action, but they do not yet rank the repair work. Several distinct
problems collapse into "capital blocked":

1. Jangar watch debt makes upstream action authority unsafe.
2. Forecast registry is empty, so model-backed expected edge is not available.
3. Market context is stale or slow for sampled symbols.
4. Account/window quant proof has stale alerts even when global latest metrics look fresh.
5. Paper/live gates do not yet declare the measurable hypothesis they are trying to recover.

The architecture needs a repair market. Each bid should say which proof gap it closes, what hypothesis it supports,
how much capital it could unlock, what evidence cost it consumes, and which guardrail keeps it zero-notional until the
proof is current.

## Alternatives Considered

### Option A: Keep Capital Frozen Until Every Alert Clears

Pros:

- Safest capital posture.
- Easy to audit.
- No new admission contract.

Cons:

- Does not prioritize repairs.
- Blocks paper learning even when a single account/window can be made current.
- Treats stale low-impact proof the same as high-impact critical proof.

Decision: reject.

### Option B: Let Torghut Repair Locally Without Jangar Watch-Debt Input

Pros:

- Faster local implementation.
- Keeps trading repair logic inside Torghut.
- Avoids coupling to Jangar status route changes.

Cons:

- Ignores Jangar controller watch debt and rollout authority.
- Can produce paper/live readiness while the upstream control plane is unsafe to widen.
- Duplicates material-action policy already expressed through Jangar receipts.

Decision: reject.

### Option C: Watch-Debt Fed Profit Repair Market

Pros:

- Keeps upstream control-plane risk and downstream trading proof in one admission story.
- Allows zero-notional repair while holding capital.
- Ranks repairs by expected capital unlock and evidence freshness gain.
- Gives deployers concrete gates for observe, paper, live micro, and live scale.

Cons:

- Requires Torghut to emit compact proof-repair bids.
- Requires Jangar to consume bid summaries without expensive data scans.
- Paper canaries will wait for stricter evidence than today.

Decision: select Option C.

## Architecture

Torghut emits compact profit repair bids. Jangar consumes summaries and combines them with watch-debt leases.

```text
torghut_profit_repair_bid
  bid_id
  generated_at
  expires_at
  strategy_id
  account
  window
  symbol_set_ref
  hypothesis_id
  target_action_class           # observe | paper_canary | live_micro_canary | live_scale
  expected_edge_bps
  expected_turnover_bps
  evidence_cost_score
  stale_proof_refs[]
  required_repair_actions[]
  jangar_watch_lease_ref
  max_notional                  # 0 until a capital reentry receipt allows otherwise
  rollback_target
```

Capital reentry receipts are separate from repair bids.

```text
torghut_capital_reentry_receipt
  receipt_id
  generated_at
  expires_at
  hypothesis_id
  strategy_id
  account
  window
  action_class
  jangar_watch_epoch_ref
  endpoint_parity_epoch_ref
  market_context_claim_ref
  forecast_proof_ref
  quant_alert_set_ref
  paper_settlement_ref
  tca_receipt_ref
  decision                      # observe | paper | live_micro | live_scale | hold | block
  max_notional
  max_daily_loss
  max_symbol_weight
  reason_codes[]
```

Repair bid ranking:

```text
priority = expected_edge_bps / max(1, evidence_cost_score)
priority *= freshness_recovery_multiplier
priority *= capital_stage_multiplier
priority -= open_critical_alert_penalty
```

The priority is advisory. It helps choose repair order; it never upgrades a capital gate.

## Measurable Trading Hypotheses

Hypothesis A: Forecast registry repair unlocks better paper selection.

- Claim: When at least one eligible forecast model is registered and calibrated, paper canary selection should improve
  5-day information ratio versus the no-forecast shadow baseline.
- Entry: Jangar watch debt clean for two windows, forecast registry non-empty, market context fresh, and no critical
  account/window quant alerts.
- Measure: paper canary information ratio, hit rate, realized slippage, max drawdown, and rejected-decision count.
- Guardrail: no live notional; stop paper if forecast proof expires or market-context domains become stale.

Hypothesis B: Account/window alert retirement improves capital efficiency.

- Claim: Retiring critical `metrics_pipeline_lag_seconds` alerts for a single account/window reduces false holds and
  increases the number of valid paper opportunities without increasing drawdown.
- Entry: account/window health lag <= 15 seconds during market hours, `stages[]` present in the health route, no open
  critical alerts for the account/window, and Jangar watch debt clean.
- Measure: valid paper opportunity count, stale-proof rejection count, paper PnL, turnover, and TCA.
- Guardrail: max paper notional from receipt only; live remains blocked until paper settlement passes.

Hypothesis C: Market-context freshness filters reduce stale-entry losses.

- Claim: Requiring fresh technicals, news, fundamentals, and regime context before paper admission reduces stale-entry
  drawdown without materially reducing valid opportunities.
- Entry: market-context route p95 < 2 seconds, bundle freshness <= 300 seconds, domain freshness within configured
  thresholds, and quality score >= 0.75 for the candidate symbol set.
- Measure: stale-entry rejection rate, next-session drawdown, Sharpe delta, and missed opportunity count.
- Guardrail: if the market-context route times out or degrades, observe remains open but paper/live are held.

## Gate Policy

- `observe`: allowed when Jangar serving is available and no capital is mutated.
- `proof_repair`: allowed only with `max_notional=0`, bounded runtime, and a Jangar watch repair lease or clean epoch.
- `paper_canary`: allowed only when:
  - Jangar watch-debt epoch is clean for two consecutive windows;
  - endpoint parity is current;
  - forecast proof is non-empty and calibrated or explicitly waived for a no-forecast hypothesis;
  - market context is fresh for the candidate symbol set;
  - account/window quant health is scoped and fresh;
  - open critical alerts for the account/window are zero;
  - empirical jobs are fresh.
- `live_micro_canary`: blocked until paper settlement meets configured TCA, drawdown, and hit-rate gates.
- `live_scale`: blocked until live micro settlement passes and an operator or approved automated policy escalates.

## Implementation Scope

Engineer stage should implement this after Jangar exposes `watch_debt_clearing_epoch`:

1. Add compact proof-repair bid generation from Torghut quant alerts, market-context health, and forecast registry
   status.
2. Add a Jangar adapter that reads only bid summaries, not raw large metric series.
3. Extend Torghut action SLO budgets and material-action receipts with bid ids and capital reentry receipt ids.
4. Add account/window filters to quant alert checks used by paper/live gates.
5. Add no-capital proof-repair admission and keep paper/live decisions separate.
6. Add route and unit tests for forecast-empty, market-context stale, open-critical-alert, clean-watch, and paper
   settlement cases.

No schema change is required for the first shadow pass if bids are generated from existing route data. Persist bids only
after the reducer proves stable and query paths remain bounded.

## Validation Gates

Required engineer checks:

- Unit: open critical account/window alerts block paper and live but allow proof repair.
- Unit: forecast `registry_empty` blocks paper unless a no-forecast hypothesis waiver is attached.
- Unit: market-context timeout blocks paper/live and creates a market-context repair bid.
- Unit: clean Jangar watch debt alone does not allow paper when Torghut proof is stale.
- Unit: stale Jangar watch debt blocks paper/live even when Torghut proof is fresh.
- Route: profit repair bids include expected edge, evidence cost, stale proof refs, and zero notional.
- Route: capital reentry receipts are distinct from repair bids and carry max notional only after paper gates pass.

Suggested local commands:

```bash
bun run --filter jangar test -- services/jangar/src/routes/api/torghut/trading/control-plane/quant/-alerts.test.ts
bun run --filter jangar test -- services/jangar/src/routes/api/torghut/trading/control-plane/quant/-health.test.ts
bun run --filter jangar test -- services/jangar/src/server/__tests__/torghut-quant-metrics-store.test.ts
```

Required deployer checks:

```bash
curl -fsS 'http://jangar.jangar.svc/api/torghut/trading/control-plane/quant/alerts?state=open' | \
  jq '[.alerts[] | select(.severity=="critical")] | length'
curl -fsS 'http://jangar.jangar.svc/api/torghut/trading/control-plane/quant/health?strategy_id=db327e20-4d37-45f3-bf18-5c51e844de31&account=PA3SX7FYNUTF&window=1m' | \
  jq '.status,.metricsPipelineLagSeconds,.pipelineHealthScoped,.stages'
curl -fsS 'http://jangar.jangar.svc/api/torghut/market-context/health?symbol=NVDA' | jq '.health.overallState'
curl -fsS 'http://jangar.jangar.svc/api/agents/control-plane/status?namespace=agents' | \
  jq '.watch_debt_clearing_epoch,.torghut_action_slo_budgets'
```

Paper promotion is blocked while any required route is unavailable, the Jangar watch-debt epoch is missing or degraded,
or the account/window alert set has critical open alerts.

## Rollout Plan

1. **Shadow bids:** emit proof-repair bids without changing capital gates.
2. **Repair-only admission:** allow zero-notional proof repairs when Jangar grants a repair lease.
3. **Paper gate:** require clean watch debt, endpoint parity, forecast proof, market-context freshness, and zero critical
   account/window alerts.
4. **Paper settlement:** record TCA, hit rate, drawdown, and stale-proof exits.
5. **Live micro gate:** allow only if paper settlement passes and operator or policy approval exists.
6. **Live scale gate:** keep blocked until live micro settlement and drawdown evidence are strong enough for escalation.

## Rollback Plan

- Disable bid consumption first and fall back to existing `torghut_observe` plus capital holds.
- If a bid generator is noisy, keep route output visible but remove it from action receipts.
- If market-context routes time out, hold paper/live and continue observe; do not widen to capital on missing context.
- If account/window quant routes become expensive, disable scoped capital gates and require manual paper review until the
  query path is bounded again.
- Never roll back by deleting alert history, paper settlement records, or capital receipts.

## Risks And Mitigations

- **Bid ranking may overvalue noisy hypotheses.** The ranking is advisory only and cannot upgrade capital gates.
- **Fresh global quant health can hide stale account/window proof.** Paper and live gates require scoped health and
  zero critical account/window alerts.
- **Market-context providers may be slow.** Timeouts create repair bids and hold paper/live, while observe remains open.
- **Forecast registry can stay empty.** A no-forecast waiver must name the hypothesis, baseline, and paper-only bounds.
- **Jangar watch debt can block trading even when Torghut proof is fresh.** That is intentional; upstream control-plane
  authority is part of the capital safety contract.

## Handoff Contract

Engineer acceptance gates:

- Torghut proof-repair bids are compact, zero-notional, and bounded.
- Capital reentry receipts are separate from repair bids and cannot appear without required proof refs.
- Paper gates require clean Jangar watch debt, endpoint parity, forecast proof, market-context freshness, scoped quant
  health, and zero open critical account/window alerts.
- Tests cover stale forecast, stale market context, open alerts, clean watch, degraded watch, and paper settlement.

Deployer acceptance gates:

- Observe remains available.
- Proof repair requires zero notional and a current lease or clean watch epoch.
- Paper remains held until critical alert count for the candidate scope is zero and market-context/forecast evidence is
  current.
- Live micro and live scale remain blocked until paper settlement and TCA evidence pass.

Done means Torghut can keep learning while unsafe capital is held, and every repair run explains the profit hypothesis
and proof gap it is retiring.
