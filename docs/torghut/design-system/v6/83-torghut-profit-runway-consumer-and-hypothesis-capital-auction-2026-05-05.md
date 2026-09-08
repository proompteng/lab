# 83. Torghut Profit Runway Consumer and Hypothesis Capital Auction

Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Status: Accepted for implementation planning

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

Torghut should become an explicit consumer of Jangar's `ControlPlaneProofRunway` and use that runway as one input to a
profit-directed capital auction. I am choosing this because today's live state has a high-risk contradiction: Torghut
is serving and the simple lane reports `live_submission_gate.allowed=true`, while the economic evidence is not
capital-grade. There are no promotion-eligible hypotheses, signal continuity is alerting during market hours, the TCA
summary is stale from 2026-04-02, market-context news and fundamentals are stale for NVDA, and Jangar quant health for
`paper/15m` returned an empty reply from the control-plane route.

The selected design keeps Torghut serving, observing, replaying, and repairing during degraded windows. It blocks
non-shadow broker submission unless the order has an `OrderAdmissionWarrant` tied to a fresh Jangar runway, a fresh
Torghut proof bundle, and a winning allocation from a bounded hypothesis capital auction. Routes can no longer be the
final authority for external capital.

The tradeoff is additional hot-path proof checking. I accept that tradeoff because the current simple-lane shortcut can
turn stale evidence into live permission. Profitability depends on post-cost proof, not only route availability.

## Evidence Captured

### Cluster and Route State

- Torghut pods are mostly running: live service, sim service, Postgres, ClickHouse, Keeper, TA workers, options workers,
  websocket forwarders, and exporters were present in `torghut`.
- Torghut events showed repeated DB migration and backfill jobs completing and recent rollout churn. The cluster can
  run the service, but startup and readiness warnings still occur around TA/options rollouts.
- `/healthz` returned `{"status":"ok","service":"torghut"}`.
- `/db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, no missing heads, no unexpected heads, and schema lineage ready.
- `/trading/status` returned `mode=live`, `execution_lane=simple`, `kill_switch_enabled=false`, and
  `live_submission_gate.allowed=true`.

### Economic and Data Proof State

- The live gate reported `promotion_eligible_total=0`, `dependency_quorum_decision=informational_only`, and
  `empirical_jobs_ready=null` in the simple lane.
- Signal continuity was in an alerting market-session state with `alert_reason=cursor_tail_stable`.
- TCA evidence showed `order_count=13775`, `avg_abs_slippage_bps=568.6138848199565249`, no expected-shortfall coverage,
  and `last_computed_at=2026-04-02T20:59:45.136640Z`.
- Jangar market-context health for `NVDA` was `degraded`; technicals and regime were fresh, but fundamentals and news
  were stale by multi-week windows.
- Jangar quant health for `account=paper&window=15m` returned an empty reply. That is enough to hold any capital class
  that depends on that proof surface.

### Source and Test Surface

- `services/torghut/app/main.py::_build_live_submission_gate_payload` has a simple-lane branch that allows live
  submission from local toggles, kill switch, simple-submit enablement, and emergency-stop state.
- `services/torghut/app/trading/submission_council.py::build_live_submission_gate_payload` is already closer to the
  target because it evaluates dependency quorum, empirical jobs, quant health, promotion eligibility, TCA, critical
  toggles, and certificate evidence.
- The immediate source gap is route independence: the broker boundary still needs a warrant check that cannot be
  bypassed by a status-route helper.
- The existing quant health route and tests already treat empty latest stores and account/window scoping as degraded.
  The missing behavior is wiring that degraded proof into broker admission and capital allocation.

## Problem

Torghut currently has three truths that can diverge:

1. service truth: the process is up and `/healthz` returns ok;
2. route truth: the simple lane reports live submission ready;
3. profit truth: hypotheses, signal continuity, empirical jobs, TCA, market context, and Jangar proof determine whether
   external capital has a positive expected edge.

Only profit truth should allow live capital. Service truth should keep operators informed. Route truth should explain
current state. Neither should be able to send a non-shadow order to the broker without proof.

## Alternatives Considered

### Option A: Patch the Simple Lane to Use the Submission Council

Make the simple-lane status payload call the proof-aware submission council.

Pros:

- fast and necessary;
- reduces false-positive status output;
- reuses existing proof logic.

Cons:

- still depends on every caller using the same helper;
- does not create an order-local proof;
- does not allocate scarce capital among competing hypotheses;
- does not bind broker results back to Jangar rollout proof.

Decision: required first step, not sufficient as the architecture.

### Option B: Global Live Capital Freeze

Disable all live orders whenever Jangar proof, empirical jobs, signal continuity, or market context is degraded.

Pros:

- simple incident posture;
- hard to accidentally trade through a known outage;
- easy to validate.

Cons:

- blocks shadow and repair loops that create the missing proof;
- treats all missing proof as equal;
- leaves no learning signal for which hypothesis should get capital first when proof returns;
- encourages manual overrides because it is too coarse.

Decision: keep as an emergency kill posture, not the steady state.

### Option C: Profit Runway Consumer and Hypothesis Capital Auction

Torghut consumes Jangar's proof runway, builds an account/window profit proof bundle, and mints broker-bound order
warrants only for hypotheses that win a bounded capital auction.

Pros:

- makes route readiness insufficient for live orders;
- turns proof quality into capital allocation rather than a binary route flag;
- keeps observe, shadow, replay, and repair work running during degraded windows;
- creates per-order evidence for fills, rejects, and holds;
- lets Jangar and Torghut share one release/platform digest in audit trails.

Cons:

- adds hot-path checks;
- needs careful cache and expiry budgets;
- requires shadow comparison before enforcement.

Decision: select Option C.

## Chosen Architecture

### ProfitRunwayConsumer

Torghut fetches and caches the Jangar `ControlPlaneProofRunway` for the active release, account, and proof window. The
consumer normalizes it into:

- `runway_id`
- `release_digest`
- `fresh_until`
- `allowed_action_classes`
- `external_capital_allowed`
- `negative_evidence_refs`
- `repair_hints`
- `proof_digest`

Rules:

- missing, expired, mismatched, or `external_capital=false` runway means non-shadow orders are held;
- `serve`, `observe`, `shadow`, `replay`, and `repair` can continue if their local gates allow;
- manual override must include actor, reason, expiry, account/window/symbol scope, and max notional.

### HypothesisCapitalAuction

Create one auction round per account and proof window. Each candidate hypothesis receives a bounded allocation only if:

- Jangar runway allows `external_capital`;
- the hypothesis is promotion eligible and `rollback_required=false`;
- empirical jobs are fresh for the hypothesis family;
- signal continuity is healthy for the symbol family;
- market-context domains required by the strategy are fresh;
- quant latest metrics are non-empty and inside lag budget for the same account/window;
- TCA expected and realized cost are inside the hypothesis budget;
- replay or shadow evidence covers the current session template.

The auction returns `max_notional`, `max_quantity`, `expires_at`, and reason codes. It does not return an unbounded
"go live" flag.

### OrderAdmissionWarrant Enforcement

Every non-shadow broker order must carry a warrant with:

- `warrant_id`
- `runway_id`
- `auction_round_id`
- `account`
- `window`
- `symbol`
- `side`
- `hypothesis_id`
- `strategy_id`
- `max_notional`
- `max_quantity`
- `issued_at`
- `expires_at`
- `decision`
- `reason_codes`
- `proof_digest`

The broker adapter rejects missing, expired, mismatched, over-budget, or downgraded warrants before submitting to
Alpaca. Shadow and replay orders record the proof digest when available but do not require a live warrant.

## Profitability Hypotheses

- `RUNWAY-FP-01`: non-shadow orders without a fresh Jangar runway fall to zero after enforcement.
- `AUCTION-EV-01`: capital auction improves post-cost expected value by allocating only to hypotheses with fresh replay
  or shadow proof. Success requires three consecutive market sessions of positive post-cost shadow evidence before
  canary.
- `TCA-HOLD-01`: stale or uncovered TCA blocks scale-up. Success is no live scale while expected-shortfall coverage is
  zero or realized slippage breaches the hypothesis budget.
- `REPAIR-FOCUS-01`: held auction rounds reduce stale proof duration by emitting the smallest repair hint. Success is a
  measurable decline in empirical-job, quant-store, and market-context holds over the first rollout week.

## Engineer Scope

1. Patch the simple-lane status path to call or mirror the proof-aware submission council.
2. Add the Jangar runway client with expiry, release digest, account/window scope, and failure classification.
3. Add the pure hypothesis capital auction builder and tests for allow, hold, shadow-only, repair-only, and manual
   override cases.
4. Add broker-adapter warrant enforcement in shadow mode, then enforce mode.
5. Persist warrant, auction, and broker reconciliation rows or extend the existing execution audit tables with the
   proof identifiers.
6. Update status routes to show route readiness and profit authority separately.

## Validation Gates

- Unit test: simple-lane live status cannot return `allowed=true` when submission council proof blocks.
- Unit test: missing or expired Jangar runway holds non-shadow warrants.
- Unit test: empty quant latest store or quant route fetch failure holds external capital for the matching account and
  window.
- Unit test: stale TCA or zero expected-shortfall coverage blocks scale-up.
- Integration test: broker adapter rejects a non-shadow order without a valid warrant.
- Shadow rollout: for two market sessions, record what the warrant layer would have rejected while the current path
  remains unchanged.
- Enforcement rollout: no non-shadow broker order can leave Torghut without a warrant id and runway id.

## Rollout and Rollback

Rollout:

1. Patch status route parity first so operators stop seeing a false live-ready signal.
2. Add runway consumption and warrant minting in shadow mode.
3. Compare shadow rejections against actual orders for two market sessions.
4. Enforce broker rejection for new non-shadow orders with missing or expired warrants.
5. Enable the capital auction after shadow evidence shows zero false-positive live submissions.

Rollback:

- Turn warrant enforcement back to shadow while preserving all proof and reconciliation writes.
- If the Jangar runway route is unavailable, hold non-shadow warrants and keep shadow/replay/repair active.
- If auction calculation regresses, fall back to the proof-aware submission council and max-notional zero for live
  capital.

## Handoff

Engineer acceptance gate: Torghut can demonstrate a route that is healthy but not capital-authoritative, and the broker
adapter rejects the live order unless a fresh Jangar runway and auction-backed warrant are attached.

Deployer acceptance gate: enabling live capital requires a fresh Jangar runway, a Torghut auction round, non-empty quant
latest metrics for the exact account/window, healthy signal continuity, current TCA evidence, and a warrant rejection
smoke that proves missing proof cannot reach the broker.
