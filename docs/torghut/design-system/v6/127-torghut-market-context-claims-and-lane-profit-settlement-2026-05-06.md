# 127. Torghut Market-Context Claims And Lane Profit Settlement (2026-05-06)

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

Torghut will publish **market-context claims** and settle them into lane-local profit decisions before any paper or
live capital can depend on Jangar's global market-data health.

At `2026-05-06T16:08Z`, Torghut's market-context providers were configured and recently successful, but the `NVDA`
bundle was still degraded. Technicals and regime were fresh. Fundamentals were stale for `4760675` seconds against an
`86400` second limit. News was stale for `1583` seconds against a `600` second limit. The detailed context had
`qualityScore=0.95`, `contextVersion=torghut.market-context.v1`, and risk flags including `fundamentals_stale`,
`supplier_partnership_execution_risk`, `china_market_overhang`, `relative_momentum_lag`, and `news_stale`.

That evidence says the data plane is partially useful, not capital-ready. An intraday lane may still observe fresh
technicals and regime. It should not promote, widen, or run a paper/live canary that depends on stale fundamentals or
stale news unless the lane explicitly excludes those domains and records why.

The selected direction is to make market context a first-class profit settlement input. Torghut names each lane's
required domains, publishes a compact claim with domain states and freshness, and records a lane profit settlement that
Jangar can consume. Jangar is not asked to infer trading semantics from raw route payloads.

The tradeoff is stricter paper reentry. I accept that because stale narrative or fundamental data can turn a measured
edge into a false positive. Torghut profitability improves when the system knows which evidence was fresh when capital
was admitted.

## Runtime Objective And Success Metrics

This contract increases profitability by tying capital promotion to fresh lane-relevant data instead of aggregate
market-context health.

Success means:

- Every active lane has declared required market-context domains.
- Torghut emits a bounded `market_context_claim_set` for symbols and lanes considered for paper or live capital.
- The claim distinguishes fresh required domains, stale required domains, and intentionally excluded domains.
- Lane profit settlement cites one Jangar market-context contradiction epoch when Jangar consumes the claim.
- Paper and live promotion remain impossible while a required domain is stale, missing, or unclaimed.
- Observe and zero-notional repair remain available when stale domains do not prevent evidence collection.

## Evidence Snapshot

All evidence was collected read-only with respect to trading flags, database records, and Kubernetes resources.

### Runtime And Data Evidence

- `GET /api/torghut/market-context/health?symbol=NVDA` returned `ok=true` and `overallState=degraded`.
- Provider health was not failing: fundamentals and news providers were configured, succeeded at
  `2026-05-06T16:07:54Z`, and had `0` consecutive failures.
- ClickHouse ingestion health was configured and succeeded at `2026-05-06T16:07:53Z`.
- Domain health was mixed:
  - `technicals=ok`, freshness `4` seconds, max `60`, quality `1`;
  - `regime=ok`, freshness `4` seconds, max `120`, quality `1`;
  - `fundamentals=stale`, freshness `4760675` seconds, max `86400`, quality `0.96`;
  - `news=stale`, freshness `1583` seconds, max `600`, quality `0.84`.
- The detailed route returned `contextVersion=torghut.market-context.v1`, `symbol=NVDA`,
  `asOfUtc=2026-05-06T16:09:58Z`, `qualityScore=0.95`, and stale-domain risk flags.
- Jangar dependency quorum still projected `market_data_context=healthy`, proving the need for a reconciled claim
  rather than another aggregate health label.

### Source Evidence

- `services/jangar/src/server/torghut-market-context.ts` evaluates provider health, domain freshness, risk flags, and
  bundle quality.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already accepts a Torghut input shape for
  `market_context_status` and `market_context_stale_domains`.
- `services/jangar/src/server/control-plane-status.ts` does not yet pass a Torghut market-context input into that
  reducer.
- `services/torghut/app/trading/hypotheses.py` already has dependency concepts for `market_context_freshness` and
  `jangar_dependency_quorum`.
- `services/torghut/app/trading/scheduler/pipeline.py` records market-context observations and can shadow-block LLM
  decisions when market context is unavailable.
- `services/torghut/app/trading/autonomy/lane.py` owns high-blast-radius lane promotion and dependency quorum
  consumption.

### Database And Schema Evidence

- Jangar database status was healthy through the control-plane status route, with migration consistency `28/28` and
  latest migration `20260505_torghut_quant_pipeline_health_window_index`.
- Direct CNPG CRD access was forbidden for this service account, so claim consumers must not require operator-level
  CNPG permissions.
- Current market-context data proves a freshness-quality split: the bundle quality score can remain high while
  individual required domains are stale.
- This design therefore requires domain-level claim rows instead of a single freshness boolean.

## Problem

Torghut has market-context data, hypothesis dependencies, and local market-context gates, but it lacks a compact
claim that can be shared with Jangar and reused in profit settlement.

Without that claim:

1. Jangar can project market data healthy while Torghut knows a lane has stale domains.
2. Torghut can block locally, but the reason is not durable in Jangar material action receipts.
3. A future capital promotion can cite a global dependency quorum without proving domain freshness.
4. Profit analysis cannot tell whether stale news, stale fundamentals, or fresh technicals drove a hold.

## Alternatives Considered

### Option A: Use The Existing Bundle Health Route As Authority

Torghut would let Jangar call the market-context health route and map `overallState` into capital gates.

Pros:

- Minimal new surface.
- Uses an existing endpoint.
- Good enough for basic degraded/healthy display.

Cons:

- Does not name lane-required domains.
- Cannot distinguish stale but irrelevant domains from stale required domains.
- Does not produce a durable settlement id.
- Encourages Jangar to infer trading semantics from a generic route.

Decision: reject.

### Option B: Enforce Market-Context Gates Only In The Scheduler

The scheduler continues to shadow-block or reject LLM/trading decisions when market context is stale. Jangar receives
only final capital status.

Pros:

- Keeps enforcement close to trading decisions.
- Avoids cross-plane schema work.
- Preserves existing local behavior.

Cons:

- Jangar material action receipts still omit stale-domain evidence.
- Cross-swarm deployers cannot audit why capital was held.
- Scheduler-local enforcement does not prevent a contradictory Jangar projection from becoming promotion evidence.
- Profit review cannot compare lane outcomes by claim freshness.

Decision: reject as incomplete.

### Option C: Market-Context Claims And Lane Profit Settlement

Torghut publishes domain-level claims per lane and symbol, then settles each claim into an observe, repair, paper,
live-micro, or live-scale decision. Jangar consumes the claim set through the companion contradiction ledger.

Pros:

- Gives Jangar one compact, bounded projection.
- Keeps trading semantics in Torghut.
- Blocks only the lanes and stages that require stale domains.
- Produces durable profit and rollback evidence.
- Supports future research on which context domains improve risk-adjusted return.

Cons:

- Requires lane dependency declarations.
- Requires claim expiry and backfill for active lanes.
- Adds one projection and one settlement reducer.

Decision: select Option C.

## Architecture

Torghut adds a `market_context_claim_set`.

```text
market_context_claim_set
  claim_set_id
  generated_at
  expires_at
  context_version
  invocation_ref
  provider_health_digest
  symbol_count
  lane_count
  overall_decision                    # allow_observe, hold_paper, block_live
```

Each lane claim is explicit.

```text
market_context_lane_claim
  claim_id
  claim_set_id
  lane_id
  symbol
  strategy_family
  account_scope
  required_domains
  excluded_domains
  exclusion_reasons
  domain_states
  domain_as_of
  domain_freshness_seconds
  domain_max_freshness_seconds
  quality_score
  risk_flags
  decision                            # allow_observe, repair_only, hold_paper, block_live, excluded
  required_repairs
```

Lane profit settlement consumes the claim.

```text
lane_profit_settlement
  settlement_id
  claim_id
  hypothesis_id
  action_class                        # torghut_observe, paper_canary, live_micro_canary, live_scale
  expected_edge_bps
  confidence
  data_freshness_discount_bps
  post_cost_expected_edge_bps
  capital_decision                    # observe, hold, block, allow_shadow
  jangar_contradiction_epoch_ref
  rollback_target
```

Rules:

1. Missing claim means observe-only.
2. Stale required `technicals` or `regime` blocks paper and live for intraday lanes.
3. Stale required `fundamentals` or `news` holds paper and live unless excluded by lane declaration.
4. Excluded domains reduce confidence and must be visible in profit settlement.
5. A claim expires before it can be reused for a new capital window.
6. A lane cannot cite Jangar dependency quorum alone; it must cite the claim id and settlement id.

## Profitability Hypotheses

H1: Capital admitted only with fresh lane-required domains will improve post-cost Sharpe versus capital admitted from
aggregate market-context health.

H2: Explicit domain exclusions will reduce false positives by forcing lower confidence or hold decisions when a lane
cannot prove why stale fundamentals or news are irrelevant.

H3: Keeping observe available during stale non-required domains will increase useful evidence volume without
increasing live risk.

Measurement:

- compare paper/live candidates by claim decision and stale domain set;
- track post-cost expected edge versus realized paper/live outcome;
- track capital holds avoided by explicit, reviewed domain exclusions;
- track rollback reasons by claim id.

## Implementation Scope

Torghut engineer stage owns:

- Add lane required-domain declarations for active hypothesis families.
- Build the claim set from the existing market-context bundle and health functions.
- Add lane profit settlement records or route payloads that cite claim ids.
- Expose a bounded claim endpoint or projection for Jangar.
- Add tests for stale fundamentals, stale news, stale technicals, excluded domains, and missing claims.

Jangar engineer stage owns the companion consumption and material action receipt integration.

Deployer stage owns:

- Verify claim freshness from routes, not CNPG operator permissions.
- Keep live capital disabled while claim enforcement is shadow.
- Confirm paper/live capital cannot proceed with stale required domains.

## Validation Gates

- Unit: stale required fundamentals holds paper and live for lanes that require fundamentals.
- Unit: stale news holds paper/live unless a lane exclusion is present and audited.
- Unit: stale technicals blocks intraday paper/live.
- Unit: missing claim produces observe-only.
- Route: claim payload includes `claim_set_id`, `claim_id`, required domains, stale domains, and decision.
- Cross-system: Jangar status carries the claim id in market-context contradiction and material action receipts.
- Manual: rerun the `NVDA` health sample and verify stale fundamentals/news become claim-level evidence.

## Rollout

1. Publish claims in shadow without changing capital behavior.
2. Add profit settlement ids to paper and live candidates.
3. Feed claim ids to Jangar and verify contradiction epochs.
4. Hold paper/live when required domains are stale.
5. Require claim ids for all non-observe capital.
6. Review domain exclusions weekly until there are two weeks of stable claim behavior.

## Rollback

- If claim production fails, keep observe available and block non-observe capital.
- If claims are too strict, move enforcement back to shadow while retaining settlement ids.
- If exclusions are abused, disable exclusions and require all domains fresh for paper/live.
- If Jangar consumption fails, Torghut local gates remain authoritative for capital and Jangar keeps live blocked.

## Risks

- Domain declarations can lag strategy evolution. They must be versioned with strategy family and hypothesis id.
- A stale but high-quality bundle can still look attractive. Settlement must use domain-level freshness, not only
  quality score.
- More route payloads can add latency. Claims should be cached and bounded by symbol/lane.
- Exclusions can become a loophole. They require explicit reasons and should lower confidence until measured.

## Handoff

Engineer acceptance gates:

- The current `NVDA` evidence produces a claim with stale `fundamentals` and `news`.
- A lane requiring either domain cannot leave observe.
- A lane excluding those domains records exclusion reasons and reduced confidence.
- Jangar receives claim ids without scanning Torghut databases.

Deployer acceptance gates:

- Live capital remains blocked until claim and empirical gates are current.
- Paper canary stays held for stale required domains.
- Rollback preserves observe and claim history.
