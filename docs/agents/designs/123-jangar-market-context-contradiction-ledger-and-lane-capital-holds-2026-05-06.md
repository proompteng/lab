# 123. Jangar Market-Context Contradiction Ledger And Lane Capital Holds (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane status, negative evidence routing, market-context freshness, material action receipts,
rollout safety, and Torghut lane-local capital gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/127-torghut-market-context-claims-and-lane-profit-settlement-2026-05-06.md`

Extends:

- `122-jangar-evidence-pressure-governor-and-data-cost-rollout-cells-2026-05-06.md`
- `121-jangar-material-action-repair-clearing-lane-and-profit-proof-ledger-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`

## Decision

I am selecting a **market-context contradiction ledger with lane-local capital holds** as the next Jangar control-plane
contract.

The control plane is healthier than the May 5 evidence-clock baseline. At `2026-05-06T16:08Z`, Jangar reported
healthy database connectivity, healthy migration consistency at `28/28`, healthy execution trust, healthy rollout for
`agents=1/1` and `agents-controllers=2/2`, healthy watch reliability with `4047` events, `0` errors, and `3`
restarts, and fresh discover, plan, implement, and verify stages. The swarm had `0` pending requirements.

The same sample exposes a capital-safety contradiction. Jangar's dependency quorum reported the
`market_data_context` segment as `healthy`, while the Torghut market-context health route for `NVDA` reported
`overallState=degraded`. Its fundamentals domain was stale for `4760675` seconds against an `86400` second limit, and
its news domain was stale for `1583` seconds against a `600` second limit. The providers were configured and had
recent successful attempts, so this is not a provider outage. It is a freshness contradiction between the global
control-plane projection and the lane data that capital decisions need.

The selected direction is not to make stale market context a global Jangar outage. Serving, observe, and bounded
repair should continue. The selected direction is to make every paper, live micro-canary, live scale, and merge-ready
decision cite a reconciled market-context claim. If Jangar says market data is healthy while Torghut says a lane's
required domains are stale, Jangar records a contradiction, keeps observe allowed, and holds non-observe capital until
the stale domains are refreshed or explicitly excluded from that lane.

The tradeoff is more typed projection work between Jangar and Torghut. I accept that. The six-month risk is that
"green enough" aggregate status lets a profitable-looking hypothesis reuse stale fundamentals or stale news in a live
promotion path. That risk is worse than the cost of a compact freshness claim.

## Runtime Objective And Success Metrics

This contract improves Jangar resilience by reducing false-positive promotion authority and improves Torghut
profitability by forcing capital to use lane-relevant data rather than aggregate health.

Success means:

- Jangar emits one `market_context_contradiction_epoch` per status window when global market-data health and
  lane-local market-context health disagree.
- The negative evidence router consumes Torghut market-context input in the same reducer that already handles
  empirical jobs, controller witnesses, workflow failures, and failure-domain leases.
- `torghut_observe` remains allowed when only market-context freshness is stale.
- `paper_canary`, `live_micro_canary`, `live_scale`, and `merge_ready` are held or blocked when a required
  market-context domain is stale, missing, or contradicted.
- Material action activation receipts carry the market-context claim id, stale domain names, and required repair
  actions.
- Deployer and engineer stages can validate the behavior from route payloads and reducer fixtures without privileged
  database or cluster access.

## Evidence Snapshot

All evidence was collected read-only with respect to Kubernetes resources and database records.

### Cluster And Rollout Evidence

- `kubectl config current-context` was unset, but reads succeeded as `system:serviceaccount:agents:agents-sa`.
- `deployment/jangar` was successfully rolled out and the active pod `jangar-7b6c986c76-g98bk` was `2/2 Running`.
- Jangar namespace deployments were available: `bumba=1/1`, `jangar=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`.
- Agents namespace swarms `jangar-control-plane` and `torghut-quant` were `Active`, `lights-out`, and `Ready=True`.
- Agents deployments were available: `agents=1/1` and `agents-controllers=2/2`.
- Recent agents events still showed readiness probe failures on current or prior controller pods, including timeouts
  and refused connections on `agents-controllers-7c6dfc8bf4`.
- Controller logs showed repeated OTLP metrics export failures to
  `observability-mimir-nginx.observability.svc.cluster.local`, which is a telemetry pressure signal rather than a
  dispatch blocker.
- CNPG custom resources were not readable by this service account. `clusters.postgresql.cnpg.io`,
  `backups.postgresql.cnpg.io`, and `scheduledbackups.postgresql.cnpg.io` returned `Forbidden`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `753` lines and composes database health, rollout health,
  workflow freshness, empirical services, execution trust, failure-domain leases, action clocks, negative evidence,
  and controller witnesses.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and already defines a
  `TorghutNegativeEvidenceInput` with `market_context_status` and `market_context_stale_domains`.
- The status builder currently calls `buildNegativeEvidenceRouterStatus` without a `torghut` input, so the router has
  the reducer shape for market-context negative evidence but not the reconciled runtime feed.
- `services/jangar/src/server/control-plane-action-clock.ts` is `276` lines and maps empirical proof and lease debt
  into material action decisions.
- `services/jangar/src/server/control-plane-controller-witness.ts` is `423` lines and builds material action
  activation receipts.
- `services/jangar/src/server/torghut-market-context.ts` is `748` lines and already evaluates domain freshness,
  provider health, quality score, and risk flags for the market-context bundle.
- `services/torghut/app/trading/hypotheses.py` is `732` lines and already understands `market_context_freshness` and
  `jangar_dependency_quorum` as promotion dependencies.
- `services/torghut/app/trading/autonomy/lane.py` is `7377` lines and is the high-risk owner for lane promotion,
  dependency quorum consumption, and candidate settlement.

### Database And Data Evidence

- Jangar status reported `database.configured=true`, `database.connected=true`, `database.status=healthy`, and a
  `3 ms` probe latency.
- Kysely migration consistency was healthy: registered `28`, applied `28`, unapplied `0`, unexpected `0`, and latest
  registered/applied migration `20260505_torghut_quant_pipeline_health_window_index`.
- Direct CNPG status and backup inspection was blocked by RBAC, so this design treats service-owned status and bounded
  projections as the required read surface for deployers and engineers.
- Torghut market-context health for `NVDA` reported `overallState=degraded`.
- The same health response reported `technicals=ok`, `regime=ok`, `fundamentals=stale`, and `news=stale`.
- Provider health was not the issue: fundamentals and news providers were configured, had successful attempts at
  `2026-05-06T16:07:54Z`, and had `0` consecutive failures.
- The detailed market-context route returned `contextVersion=torghut.market-context.v1`, `symbol=NVDA`,
  `asOfUtc=2026-05-06T16:09:58Z`, `qualityScore=0.95`, and risk flags including `fundamentals_stale` and
  `news_stale`.

### Runtime API Evidence

- Jangar dependency quorum was `block` only because of `empirical_jobs_degraded`; its `market_data_context` segment
  was still `healthy`.
- Jangar negative evidence included `controller_witness_split`, `empirical_jobs_degraded`, and
  `empirical_jobs_stale`, but did not include `market_context_stale`.
- Action SLO budgets allowed `torghut_observe`, held `paper_canary`, and blocked `live_micro_canary` and `live_scale`
  for empirical job reasons. They did not cite market-context stale domains.
- Material action receipts kept observe allowed, held `merge_ready`, held `paper_canary`, and blocked live capital.
  They did not yet carry a market-context claim id.

## Problem

Jangar has a useful global status plane and Torghut has useful lane data. They do not yet settle contradictions between
those planes.

Three failure modes are active:

1. A global segment can report market data healthy while a lane's required domains are stale.
2. Capital budgets can hold for empirical jobs but omit market-context freshness from their repair list.
3. Deployer and engineer stages cannot prove whether stale fundamentals or news are intentionally excluded from a
   lane, safely irrelevant, or accidentally masked by aggregate health.

This is a reliability problem because rollout and merge authority can look cleaner than it is. It is also a
profitability problem because stale feature inputs can make a strategy look more attractive than it is in the current
market.

## Alternatives Considered

### Option A: Treat Any Market-Context Degradation As A Global Dependency Quorum Block

Jangar would turn `market_data_context` from healthy to block whenever the Torghut market-context health route is
degraded.

Pros:

- Simple to explain.
- Fail-closed for capital.
- Uses an existing dependency quorum segment.

Cons:

- Over-blocks serving and platform work for lane-local data issues.
- Does not distinguish stale fundamentals from stale news or technical/regime freshness.
- Makes observe and repair less available during data refresh windows.
- Gives Torghut no way to prove a lane does not require a stale domain.

Decision: reject. The evidence calls for lane-local holds, not a global outage.

### Option B: Leave Market-Context Freshness Entirely Inside Torghut

Torghut would keep rejecting or shadowing stale market-context decisions locally. Jangar would continue to gate only on
rollout, workflows, empirical jobs, database, and controller evidence.

Pros:

- Keeps trading-domain logic in Torghut.
- Avoids a new Jangar projection.
- Faster to implement locally.

Cons:

- Preserves the contradiction between Jangar status and Torghut route health.
- Leaves material action receipts without a market-context evidence ref.
- Forces deployers to compare multiple routes by hand.
- Allows Jangar merge-ready and capital budgets to omit a known stale-domain blocker.

Decision: reject as insufficient for cross-swarm authority.

### Option C: Market-Context Contradiction Ledger With Lane-Local Holds

Jangar consumes compact Torghut market-context claims, compares them with dependency quorum and negative evidence, and
emits a contradiction epoch when the surfaces disagree. The epoch applies only to affected action classes and lanes.

Pros:

- Preserves serving and observe availability.
- Blocks paper/live capital when lane-required domains are stale.
- Gives engineers one reducer and one receipt surface to test.
- Gives deployers an explicit rollback target.
- Lets Torghut prove that a stale domain is irrelevant to a specific lane instead of relying on aggregate health.

Cons:

- Adds a new projection contract.
- Requires Torghut to publish lane domain requirements.
- Requires Jangar to reconcile another bounded evidence input before enforcement.

Decision: select Option C.

## Architecture

Jangar adds a `market_context_contradiction_epoch` projection.

```text
market_context_contradiction_epoch
  epoch_id
  generated_at
  expires_at
  namespace
  global_market_data_segment_decision
  torghut_claim_set_ref
  contradiction_decision              # none, observe_only, hold_non_observe, block_live
  stale_domain_refs
  affected_action_classes
  required_repairs
  rollback_target
```

Each claim is lane-scoped.

```text
market_context_lane_claim
  claim_id
  symbol
  lane_id
  strategy_family
  required_domains                   # technicals, fundamentals, news, regime
  domain_states
  domain_freshness_seconds
  domain_max_freshness_seconds
  quality_score
  risk_flags
  torghut_context_version
  torghut_context_as_of
  claim_decision                     # allow_observe, hold_paper, block_live, excluded
  exclusion_reason
```

Reducer rules:

1. If no Torghut claim exists, keep `torghut_observe=allow` but set paper/live budgets to `hold` with
   `market_context_claim_missing`.
2. If the global segment is healthy and any required lane domain is stale, emit `market_context_contradiction`.
3. If only non-required domains are stale and Torghut names an exclusion reason, keep the lane in observe or paper
   shadow and attach the exclusion ref.
4. If `technicals` or `regime` are stale for an intraday lane, block paper and live capital.
5. If `fundamentals` or `news` are stale, hold paper/live unless the lane's declared dependency set excludes that
   domain.
6. `merge_ready` is held when the PR changes capital, market-context, hypothesis, or router code and the contradiction
   epoch is not `none`.

## Implementation Scope

Engineer stage owns:

- Add a bounded Torghut market-context claim resolver to Jangar status.
- Pass `torghut.market_context_status` and `torghut.market_context_stale_domains` into
  `buildNegativeEvidenceRouterStatus`.
- Add `market_context_claim_id` and `market_context_contradiction_epoch_id` to material action receipts.
- Add reducer tests for missing claim, stale required domains, stale excluded domains, and healthy domains.
- Keep enforcement in shadow until route payloads and receipts are stable.

Torghut engineer stage owns the companion claim producer and lane domain declarations.

Deployer stage owns:

- Verify status route payloads include contradiction epochs without requiring CNPG CRD access.
- Confirm `torghut_observe` remains allowed during stale fundamentals/news.
- Confirm paper/live actions cite market-context repairs before any non-observe capital is enabled.

## Validation Gates

- Unit: Jangar negative evidence router converts stale required domains to `market_context_stale` evidence refs.
- Unit: material action receipts include market-context claim ids and stale domain names.
- Unit: global market-data healthy plus Torghut degraded creates a contradiction epoch.
- Route: `/api/agents/control-plane/status?namespace=agents` exposes the epoch and action decisions.
- Route: `/api/torghut/market-context/health?symbol=NVDA` can be used as the source claim input during shadow.
- CI: targeted Jangar server tests and oxfmt pass before merge.
- Manual: repeat the current read-only check and verify stale fundamentals/news are visible in the Jangar status
  projection, not only in the Torghut route.

## Rollout

1. Ship the projection and receipt fields in shadow mode.
2. Emit contradictions without changing material action decisions.
3. Enable holds for `paper_canary`, `live_micro_canary`, and `live_scale`.
4. Enable `merge_ready` holds for PRs that modify capital, market-context, hypothesis, or router surfaces.
5. Graduate to enforcement only after seven consecutive status windows have current claim ids and no unexplained
   contradictions.

## Rollback

- If claims are missing or malformed, ignore the claim for serving and observe, keep non-observe capital in hold, and
  record `market_context_claim_unreadable`.
- If Jangar creates false contradictions, disable enforcement and retain shadow emission for audit.
- If Torghut excludes domains too broadly, block live capital and require lane domain declarations to be reviewed
  before re-enabling paper.
- If the market-context route is unavailable, fall back to existing empirical-job and dependency-quorum gates and keep
  live capital blocked.

## Risks

- Lane domain declarations can become stale. The claim producer must expire them and include strategy-family refs.
- A narrow domain exclusion could hide real event risk. Paper and live exclusions need an audit reason.
- More status fields can make the route noisy. The UI should group contradictions under capital and market data.
- If claim generation performs heavy database queries, it can recreate the data-pressure problem. Claims must use
  bounded projections and cached route health.

## Handoff

Engineer acceptance gates:

- A fixture matching the `2026-05-06T16:08Z` evidence produces a contradiction for stale `fundamentals` and `news`.
- `torghut_observe` remains `allow`.
- `paper_canary` is `hold`; `live_micro_canary` and `live_scale` are `block`.
- Receipts carry claim ids, stale domain refs, and repair text.

Deployer acceptance gates:

- The status route exposes a fresh contradiction epoch after deployment.
- No non-observe Torghut capital is enabled until domain freshness and empirical jobs are current.
- Rollback leaves serving and observe available while preserving contradiction history.
