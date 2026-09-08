# 140. Torghut Endpoint Parity Profit Repair And Capital Route Auction (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: route repair, paper-route probing, quote routeability, and TCA/freshness surfaces exist but remain gate-controlled.
- Matched implementation area: Routeability, TCA, fill quality, and market context.
- Current source evidence:
  - `services/torghut/app/trading/route_reacquisition.py`
  - `services/torghut/app/trading/route_reacquisition_probe.py`
  - `services/torghut/app/trading/scheduler/paper_route_probe/probe_processing.py`
  - `services/torghut/app/trading/scheduler/submission_preparation/quote_routeability.py`
  - `services/torghut/app/trading/tca`
- Design drift note: Routeability claims need current repair/probe/TCA/readiness evidence.


## Decision

I am selecting **endpoint parity profit repair with a capital route auction** as Torghut's next profitability contract.

The current evidence says Torghut is not waiting on one missing signal. It has fresh aggregate quant metrics, stale
market-context bundles, an empty forecast registry, open historical alert debt, and Jangar material-action receipts
that allow observe but hold or block paper and live capital. That is exactly the state where a trading control plane can
waste time: every repair looks important, but not every repair unlocks capital or expected profit at the same rate.

At `2026-05-07T08:09Z`, Torghut quant health through Jangar reported `4032` latest metrics, pipeline lag of `2`
seconds, and no empty latest-store alarm. The same route family reported market-context degraded: bundle freshness of
`215421` seconds, quality score `0.4575`, and stale technicals, fundamentals, news, and regime domains. Quant alerts
still had `36` open alerts, including `23` critical `metrics_pipeline_lag_seconds` alerts and `12`
`ta_freshness_seconds` alerts. Jangar status also reported `empirical_services.forecast.status=degraded` with
`registry_empty`, while action receipts kept `torghut_observe=allow`, `paper_canary=hold`, and live classes blocked.

The selected design makes Torghut bid for the next repair using expected profit unlock, evidence age, capital-stage
impact, and Jangar endpoint-parity receipts. The tradeoff is that some stale domains will not be repaired first. I
accept that. The goal is not equal attention to every stale signal. The goal is capital-safe profit recovery.

## Runtime Objective And Success Metrics

Success means:

- Torghut never treats Jangar serving health as capital authority; it consumes the endpoint parity epoch.
- `torghut_observe` can continue at zero notional while parity, market-context, or forecast evidence is degraded.
- Paper capital remains held until endpoint parity, market-context freshness, forecast registry, TCA, and quant alert
  retirement receipts are current for the target account/window.
- Live capital remains blocked until a paper route bond has settled and the endpoint parity receipt is fresh.
- Proof repair work is ranked by expected profit unlock per evidence-cost unit.
- The auction emits reason codes that explain why a repair outranks another repair.
- Deployer rollback can force all route bonds to zero notional without stopping observation or evidence repair.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate broker state, trading flags, Kubernetes resources, database
records, GitOps manifests, or AgentRun records.

### Jangar Control-Plane Evidence Consumed By Torghut

- Jangar serving was up on image `1744b973` and `/health` returned `status=ok`.
- `/ready` returned `status=ok`, but execution trust was degraded by stale `jangar-control-plane:verify` evidence.
- `/api/agents/control-plane/status` held `merge_ready` and `deploy_widen`, allowed `dispatch_repair`, allowed
  `torghut_observe`, held `paper_canary`, and blocked live canary/scale classes.
- The status route reported controller authority split between local disabled serving-process state, heartbeat evidence,
  and rollout-derived controller substitution.
- The companion Jangar contract requires Torghut to consume an endpoint parity receipt before paper or live capital.

### Torghut Data And Profit Evidence

- `/api/torghut/trading/control-plane/quant/health` returned `status=ok`, `latestMetricsCount=4032`, and
  `metricsPipelineLagSeconds=2`.
- The quant health response skipped pipeline health by account/window with
  `pipelineHealthSkippedReason=account_and_window_required`, so aggregate freshness is not capital-stage proof.
- `/api/torghut/market-context/health` returned `overallState=degraded`.
- Market-context domain evidence was stale:
  - technicals freshness `215421` seconds versus `60` second max;
  - fundamentals freshness `4818399` seconds versus `86400` second max;
  - news freshness `4451585` seconds versus `300` second max;
  - regime freshness `215421` seconds versus `120` second max.
- Market-context provider attempts and ClickHouse ingestion were recently successful, which means the repair problem is
  stale bundle evidence, not total provider outage.
- Quant alerts had `36` open alerts: `23` critical, `13` warning. Open metrics were `metrics_pipeline_lag_seconds`,
  `ta_freshness_seconds`, and one `sharpe_annualized` alert.
- Jangar empirical services reported `forecast.status=degraded`, `message=registry_empty`, and no eligible models.
  Empirical jobs were healthy with eligible jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.

### Source Evidence

- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` exposes aggregate quant health and
  explicitly skips scoped health when account/window are omitted.
- `services/jangar/src/routes/api/torghut/market-context/health.ts` exposes provider, ingestion, domain freshness, and
  quality-score state.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` already emits Torghut action classes and
  notional limits.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already includes Torghut consumer evidence and
  forecast-service degradation as material negative evidence.
- The missing source contract is an economic ranker that converts those negative evidence refs into ordered,
  account/window-specific repair bids.

## Problem

Torghut has proof freshness without capital-priority settlement.

The aggregate quant path can be healthy while the account/window path remains unsafe for capital. Market context can be
stale while providers are currently successful. Old alerts can remain open even after a newer aggregate metric stream is
fresh. Forecast jobs can be fresh while the registry is empty. Jangar can be serving while endpoint parity is not yet
settled.

If Torghut treats those as one large degraded state, it cannot choose the next highest-value repair. If it treats only
aggregate quant health as sufficient, it risks paper/live promotion on stale context and unsettled Jangar authority.

The system needs a repair auction that prices evidence work by expected profit unlock and capital-stage effect.

## Alternatives Considered

### Option A: Keep All Capital Blocked Until Every Evidence Domain Is Green

Pros:

- Safest immediate capital posture.
- Simple to explain during incidents.
- Requires little new implementation.

Cons:

- Does not rank repairs.
- Can starve profitable zero-notional and paper-dry-run work.
- Treats a stale low-value domain the same as forecast registry absence or endpoint parity failure.

Decision: reject.

### Option B: Promote From Aggregate Quant Health

Pros:

- Uses the freshest signal in the current evidence.
- Moves fastest toward paper capital.
- Avoids spending first effort on old alert debt.

Cons:

- Aggregate health explicitly omits account/window pipeline proof.
- Ignores stale market-context domains.
- Ignores Jangar endpoint parity and forecast registry gaps.
- Can overfit capital readiness to one healthy subsystem.

Decision: reject.

### Option C: Endpoint Parity Profit Repair And Capital Route Auction

Pros:

- Consumes Jangar endpoint parity as a hard prerequisite for capital.
- Lets observe and repair continue at zero notional.
- Ranks repairs by expected profit unlock, capital-stage effect, and evidence cost.
- Separates stale market-context repair from forecast registry repair and alert-debt retirement.
- Produces route bonds that deployers can inspect before paper or live activation.

Cons:

- Requires a new reducer and fixture set.
- Requires calibrating expected-profit estimates so the auction does not chase noisy repair scores.
- May defer some stale evidence domains when they do not unlock near-term capital.

Decision: select Option C.

## Architecture

Torghut emits a profit repair auction every control-plane window.

```text
profit_repair_auction
  auction_id
  generated_at
  fresh_until
  jangar_endpoint_parity_ref
  account
  window
  capital_stage
  candidate_bids[]
  selected_bids[]
  route_bonds[]
  auction_decision
  reason_codes[]
```

Bid fields:

```text
repair_bid
  bid_id
  repair_domain                 # endpoint_parity, market_context, forecast_registry, quant_alerts, tca, paper_settlement
  hypothesis_id
  account
  window
  current_evidence_age_seconds
  current_quality_score
  expected_profit_unlock_bps
  expected_drawdown_reduction_bps
  evidence_cost_units
  capital_stage_unlocked        # observe, paper, live_micro, live_scale
  required_jangar_receipts[]
  required_torghut_receipts[]
  max_notional_after_settlement
  decision                      # bid, defer, reject
  reason_codes[]
```

Route bond fields:

```text
capital_route_bond
  route_bond_id
  jangar_endpoint_parity_ref
  repair_bid_refs[]
  account
  window
  strategy_ids[]
  capital_stage
  max_notional
  expires_at
  rollback_target
  required_settlement_receipts[]
```

## Measurable Trading Hypotheses

- `H-PARITY-01`: requiring a fresh Jangar endpoint parity receipt before paper capital reduces false paper-readiness
  clears caused by serving/status disagreement to zero in the validation window.
- `H-MCTX-02`: repairing stale technicals, news, fundamentals, and regime bundles before paper canary improves
  paper route Sharpe by at least `0.2` versus aggregate-quant-only promotion over the same account/window.
- `H-FORECAST-03`: populating the forecast registry before capital activation increases eligible model count from `0`
  to at least `2` and reduces forecast-service degradation events to zero for one deployer window.
- `H-ALERT-04`: retiring open `metrics_pipeline_lag_seconds` and `ta_freshness_seconds` alerts for the target
  strategy/account/window reduces paper route rejection rate by at least `50%`.
- `H-TCA-05`: requiring TCA settlement before live micro canary reduces realized slippage breach frequency below the
  configured route budget.

## Capital Gates And Guardrails

- `observe`: allowed with `max_notional=0` if Jangar parity is present or explicitly in `allow_readonly`.
- `paper_dry_run`: allowed only after endpoint parity, scoped quant health, and selected repair bids are fresh.
- `paper_canary`: held until endpoint parity, market-context repair, forecast registry, quant alert retirement, and TCA
  receipts are current.
- `live_micro_canary`: blocked until paper route bonds settle and no critical open alerts remain for the route.
- `live_scale`: blocked until live micro canary settles, drawdown and slippage budgets pass, and Jangar parity remains
  fresh through the full window.
- Any missing Jangar parity receipt forces `max_notional=0`.
- Any forecast registry empty state forces paper/live hold.

## Implementation Scope

Engineer stage should implement the auction as a pure reducer consumed by the Torghut control-plane routes. It should
not bypass existing material action verdicts.

1. Add a `profit_repair_auction` reducer that consumes:
   - Jangar endpoint parity ref;
   - market-context health;
   - quant health and scoped alerts;
   - empirical forecast status;
   - TCA and paper settlement receipts when available.
2. Expose selected bids and route bonds on the Torghut quant control-plane snapshot.
3. Add account/window parameters to validation fixtures so aggregate quant health cannot clear paper capital alone.
4. Feed selected repair receipts back to Jangar as consumer evidence.
5. Keep all paper/live notional at zero until the reducer emits settled route bonds.

## Validation Gates

Local validation:

- `bunx oxfmt --check services/jangar/src/routes/api/torghut services/jangar/src/server`
- `cd services/jangar && bun run test -- src/routes/api/torghut/trading/control-plane/quant src/routes/api/torghut/market-context`
- Add reducer fixtures for:
  - fresh aggregate quant health plus stale market context;
  - forecast registry empty;
  - open alert debt for account/window;
  - missing Jangar endpoint parity;
  - selected market-context repair outranking lower-value alert debt.

Runtime validation:

- Quant health remains fresh with `metricsPipelineLagSeconds <= 15`.
- Market-context freshness improves below configured domain thresholds before paper canary.
- Forecast registry has eligible models before paper canary.
- Open critical alert count is zero for the target account/window before live micro.
- Paper and live route bonds cite the Jangar endpoint parity epoch.

## Rollout

1. Emit auctions in shadow mode with zero notional.
2. Let observe and repair lanes consume selected bids.
3. Enable paper dry-run route bonds after endpoint parity and market-context repair are current.
4. Enable paper canary only after forecast registry and alert-retirement receipts are current.
5. Keep live micro and live scale disabled until paper settlement proves route quality.

## Rollback

- Set `TORGHUT_PROFIT_REPAIR_AUCTION_ENFORCEMENT=0` to return the auction to shadow mode.
- Force every route bond `max_notional` to `0`.
- Continue observe and repair lanes so stale evidence can be cleared.
- If Jangar endpoint parity disappears, invalidate all unsettled route bonds.
- If market-context or forecast evidence regresses, return paper/live to hold and keep repair bids visible.

## Risks

- Expected-profit estimates can be noisy. Start with conservative bins and require realized paper evidence before
  increasing notional.
- Old alert debt can dominate the auction even when it does not unlock capital. Score by account/window and capital
  effect, not raw alert count.
- Market-context repair can look successful at provider level while bundle freshness remains stale. Use domain
  freshness and quality score, not provider success alone.
- Endpoint parity may delay paper promotion during split-topology rollouts. That is acceptable; observe and repair
  lanes remain open.

## Handoff To Engineer

Build the auction as a deterministic reducer with clear fixtures. The reducer must consume Jangar endpoint parity and
must not promote capital from aggregate quant health alone.

Acceptance gates:

- Missing endpoint parity yields zero notional.
- Stale market context outranks lower-value repairs when it blocks paper canary.
- Forecast registry empty blocks paper/live.
- Open critical account/window alerts block live.
- Selected repair bids produce route bonds with explicit rollback targets.

## Handoff To Deployer

Deploy shadow-only first. Confirm selected bids match the current blocked gates: endpoint parity, market-context
freshness, forecast registry, scoped alert retirement, and TCA/paper settlement. Do not enable paper canary until the
route bond cites a fresh Jangar parity epoch and all required Torghut receipts are current.

Rollback trigger:

- route bond without a Jangar endpoint parity ref;
- paper/live route with non-zero notional while forecast registry is empty;
- market-context domains stale beyond thresholds after a repair is marked settled;
- critical scoped alerts open for the promoted route.
