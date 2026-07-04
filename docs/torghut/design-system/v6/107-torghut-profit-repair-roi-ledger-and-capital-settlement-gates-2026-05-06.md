# 107. Torghut Profit Repair ROI Ledger And Capital Settlement Gates (2026-05-06)

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

I am choosing a **profit repair ROI ledger with capital settlement gates** for Torghut.

Torghut's current shape is not a simple outage. Live service dependencies are reachable, schema status is current, the
kill switch is not enabled, and simulation is service-ready. The live route still returns HTTP 503 readiness because
live submission is disabled and no hypothesis is promotion eligible. Simulation returns HTTP 200, but its Jangar quant
evidence projection is degraded with no latest metrics and no pipeline stages. Jangar dependency quorum blocks globally
on stale empirical jobs.

The selected architecture treats this as repair economics, not only readiness. Every proof gap that blocks capital must
be converted into a repair lane with expected benefit, cost, sample requirement, owner, expiry, and rollback trigger.
Capital remains blocked when proof is missing. Repair remains open when it is explicitly tied to retiring a current
block. Jangar receives only the reduced capital settlement state through the companion material-action board.

The tradeoff is that Torghut will not take the fastest path from "service-ready simulation" to live capital. It will
first rebuild the proof chain that makes live capital rational: fresh account/window quant metrics, current empirical
jobs, a live submission gate that can be intentionally enabled, and hypotheses with measured post-cost edge.

## Read-Only Evidence Snapshot

No Kubernetes resources, database records, broker settings, trading settings, or runtime objects were mutated during this
assessment.

### Cluster And Route Evidence

- Torghut live deployment `torghut-00231-deployment` was available at `1/1`.
- Torghut simulation deployment `torghut-sim-00312-deployment` was available at `1/1`.
- Torghut options catalog, options enricher, equity TA, simulation TA, options TA, websocket, and exporter deployments
  were running.
- Recent events included transient readiness failures on options services, an endpoint-slice update timeout, a Flink
  status conflict warning, and successful Knative live/simulation revision creation.
- Live `/readyz` returned HTTP 503 with Postgres, ClickHouse, Alpaca, schema, lineage, and universe checks healthy, but
  live submission blocked by `simple_submit_disabled`.
- Simulation `/readyz` returned HTTP 200 in non-live mode with database dependencies healthy and capital stage `paper`.
- Live `/trading/status` returned HTTP 200 with `mode=live`, `pipeline_mode=simple`, `execution_lane=simple`,
  `kill_switch=false`, active revision `torghut-00231`, shadow-first posture, and `orders_submitted_total=0`.
- Both live and simulation readiness payloads reported three hypotheses total, zero promotion-eligible hypotheses, and
  three rollback-required hypotheses.

### Database And Data Evidence

- Direct Torghut Postgres and ClickHouse introspection were RBAC-blocked for this service account. The smallest
  unblocker is a scoped read-only DB path or approved `pods/exec`/CNPG access for `torghut`.
- Torghut service status projected database schema as current at Alembic head
  `0029_whitepaper_embedding_dimension_4096`.
- Torghut service status reported parent-fork warnings for migrations `0010` and `0015`, but no missing or unexpected
  heads.
- Universe projection was fresh with 12 symbols.
- Jangar dependency quorum returned `block` on `empirical_jobs_degraded`.
- Torghut simulation quant evidence was degraded: `latest_metrics_count=0`, no pipeline stages, and reasons including
  `quant_latest_store_alarm` and `quant_pipeline_stages_missing`.
- The live account readiness path blocked submission and reported no promotion-eligible hypotheses. That is sufficient
  capital evidence even without direct table reads.

### Source Evidence

- `services/torghut/app/main.py` is the large route composition surface at more than 4,000 lines and should not absorb
  another ad-hoc readiness interpretation.
- `services/torghut/app/trading/submission_council.py` already owns quant evidence status, live submission gate payloads,
  capital stage resolution, empirical readiness, and promotion eligibility. It is the right reducer boundary for capital
  settlement input.
- `services/torghut/app/trading/autonomy/lane.py` is the largest empirical and promotion surface and should emit proof
  state to a ledger rather than stay the only place where repair economics are implied.
- `services/torghut/app/scheduler/pipeline.py` and options repositories already provide the repair execution surfaces;
  the missing piece is a ledger that ranks and gates repairs by expected ROI and proof retirement.
- Torghut tests cover submission gates, empirical jobs, live-readiness behavior, quant evidence, options lanes, risk,
  universe, simulations, and strategy runtime. The missing regression is one reducer test proving stale empirical jobs,
  empty quant latest metrics, zero promotion eligibility, and disabled live submission settle to `repair_only` plus
  `capital_blocked`, not paper or live promotion.

## Problem

Torghut is operationally alive but not profit-authoritative.

The system has service liveness, a current schema projection, broker connectivity, and a non-live simulation path. Those
are necessary. They are not enough. The current evidence says the proof chain is broken at four points:

1. Empirical jobs are stale enough that Jangar dependency quorum blocks globally.
2. Simulation quant evidence is empty, so service-ready simulation cannot prove strategy edge.
3. Live submission is disabled, so a live route can be healthy without being capital-authoritative.
4. No hypothesis is promotion eligible and every hypothesis requires rollback.

If Torghut only says "blocked," engineer work becomes reactive and deployer validation becomes subjective. If Torghut
only says "simulation is ready," capital risk increases. The architecture must price each repair lane and define what
profit proof is required before capital can move.

## Alternatives Considered

### Option A: Stay Fully Disabled Until Manual Profit Review

Pros:

- Lowest immediate capital risk.
- Matches the current live submission gate.
- Requires no new storage or reducer.

Cons:

- Does not identify which repair produces the next dollar of option value.
- Leaves stale empirical jobs and empty quant latest metrics as passive status.
- Keeps Jangar dependency quorum blocked without a measurable repair contract.

Decision: reject as the target. Manual review remains a final approval, not the architecture.

### Option B: Promote Paper Capital After Simulation Readiness Is Green

Pros:

- Uses the service-ready simulation route.
- Lets engineering measure more live-like behavior quickly.
- Keeps live capital disabled while improving throughput.

Cons:

- Simulation readiness is green while quant evidence is empty.
- It can promote process health instead of strategy proof.
- It does not retire empirical job degradation or zero promotion eligibility.

Decision: reject. Paper capital needs proof freshness, not only route health.

### Option C: Profit Repair ROI Ledger With Capital Settlement Gates

Pros:

- Converts each blocked reason into an owned, measurable repair lane.
- Keeps repair open without letting repair become hidden capital promotion.
- Gives Jangar one compact capital state to settle against dependency quorum and leases.
- Lets Torghut rank repairs by expected edge, cost, sample need, and expiry.
- Supports options and future strategies by requiring data/proof before promotion.

Cons:

- Adds a projection and tests.
- Requires agreement on expected-profit and cost units.
- Holds capital longer when the service is alive but proof is incomplete.

Decision: select Option C.

## Chosen Architecture

### ProfitRepairRoiLedger

Torghut should project one current row per account, strategy family, proof gap, and repair lane.

```text
profit_repair_roi_ledger
  repair_id
  account
  strategy_family              # equity_intraday, options_intraday, empirical_jobs, execution, market_context
  proof_gap                    # empirical_jobs_degraded, quant_latest_metrics_empty,
                               # simple_submit_disabled, zero_promotion_eligible, hypothesis_rollback_required
  repair_lane                  # empirical_replay, quant_republish, submission_gate_rehearsal,
                               # hypothesis_requalification, broker_event_backfill, options_feature_bootstrap
  repair_state                 # proposed, running, proving, accepted, expired, rolled_back
  capital_settlement_state     # blocked, repair_only, paper_candidate, live_candidate
  expected_edge_bps
  expected_cost_bps
  expected_net_bps
  max_drawdown_bps
  required_sample_count
  observed_sample_count
  proof_fresh_until
  owner_ref
  jangar_settlement_ref
  reason_codes[]
```

Initial lane mapping:

- `empirical_jobs_degraded` maps to `empirical_replay`.
- `quant_latest_metrics_empty` maps to `quant_republish`.
- `simple_submit_disabled` maps to `submission_gate_rehearsal`.
- `zero_promotion_eligible` maps to `hypothesis_requalification`.
- `hypothesis_rollback_required` maps to `hypothesis_requalification` with rollback proof required before promotion.
- Options feature gaps map to `options_feature_bootstrap`, but options capital remains blocked until bars, features, and
  quote-quality proof exist.

### Capital Settlement Gates

Torghut should expose a reduced capital settlement payload to Jangar:

```text
capital_settlement
  account
  settlement_state             # blocked, repair_only, paper_candidate, live_candidate
  live_submission_allowed
  promotion_eligible_count
  rollback_required_count
  quant_evidence_state
  empirical_jobs_state
  expected_net_bps
  max_drawdown_bps
  repair_lanes[]
  reason_codes[]
  fresh_until
```

Rules:

- Live capital is `blocked` while `simple_submit_disabled` is true.
- Paper promotion is `blocked` while latest quant metrics are empty for the target account/window.
- Any `promotion_eligible_count=0` blocks paper and live promotion.
- Any `rollback_required_count>0` blocks promotion for the affected strategy family until rollback proof is complete.
- Empirical degradation permits `repair_only` for replay and metrics rebuild, not paper/live promotion.
- A repair lane cannot move to `accepted` unless it records expected net edge, cost, sample count, and expiry.

### Measurable Hypotheses

The first engineer stage should create these measurable repair hypotheses:

1. Empirical replay will clear `empirical_jobs_degraded` for the Jangar dependency quorum within 24 hours of repair
   start, with no new failed empirical stages.
2. Quant republish will move the simulation account from `latest_metrics_count=0` to non-empty latest metrics and at
   least one named pipeline stage for the active window.
3. Submission-gate rehearsal will prove live readiness can stay green with `orders_submitted_total=0` and no accidental
   broker submission before any live enablement.
4. Hypothesis requalification will produce at least one paper candidate with positive expected net edge after cost and
   an explicit drawdown limit.
5. Options bootstrap will remain capital-blocked until options bars, options features, and quote-quality projections are
   non-empty and fresh.

## Engineer Handoff

Implement the ledger and settlement reducer in Torghut before changing trading behavior.

Required slices:

- Add a pure reducer near `submission_council.py` that converts readiness, quant evidence, empirical status, promotion
  eligibility, and submission-gate state into `capital_settlement`.
- Add a ledger writer or projection for `profit_repair_roi_ledger` using existing migration patterns.
- Add tests for the current evidence snapshot: live 503 plus `simple_submit_disabled`, zero promotion eligibility, empty
  simulation quant metrics, and Jangar dependency block must settle to `capital_settlement_state=blocked` with repair
  lanes for empirical replay, quant republish, submission-gate rehearsal, and hypothesis requalification.
- Add tests proving service-ready simulation cannot produce `paper_candidate` when latest quant metrics are empty.
- Add tests proving options bootstrap stays capital-blocked until options feature proof is fresh and non-empty.
- Publish the reduced settlement payload where Jangar can consume it without parsing Torghut route internals.

Acceptance gates:

- The settlement reducer is deterministic and covered by fixture tests.
- Every blocked reason maps to either a repair lane or an explicit no-repair block.
- Expected edge, expected cost, sample count, and max drawdown are present before a repair lane can become accepted.
- No live or paper promotion is possible while `promotion_eligible_count=0`.

## Deployer Handoff

Roll out in four stages:

1. `observe`: emit settlement and ROI ledger rows without changing live or paper behavior.
2. `repair_only`: allow empirical replay, quant republish, submission-gate rehearsal, and hypothesis requalification
   lanes while capital remains blocked.
3. `paper_candidate`: allow paper candidates only after quant latest metrics are non-empty, empirical jobs are current,
   and at least one hypothesis has positive expected net edge after cost.
4. `live_candidate`: allow live candidate review only after Jangar material-action settlement returns
   `torghut_capital=allow`, live submission is intentionally enabled, and rollback proof is clean.

Rollback:

- Return Torghut to `observe` or `repair_only`.
- Keep ledger emission enabled for diagnosis.
- Disable any accepted repair lane whose observed sample count or drawdown violates its gate.
- Never roll back by enabling live submission; live submission is a separate explicit promotion.

## Validation Plan

- `uv run --frozen pytest services/torghut/tests -k "submission_council or empirical or quant_evidence"`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.json`
- Read-only smoke: `curl http://torghut.torghut.svc.cluster.local/readyz`
- Read-only smoke: `curl http://torghut-sim.torghut.svc.cluster.local/readyz`
- Read-only smoke: `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`

## Risks

- Expected net edge can become ceremonial if not tied to observed samples and expiry. The reducer must reject accepted
  repair lanes without sample-backed proof.
- Repair-only lanes can create load without clearing dependency quorum. Each repair needs a fresh-until and expiry.
- Jangar and Torghut can disagree on account/window naming. The first implementation must normalize account and window
  identifiers before comparing settlement states.
- Direct DB introspection is unavailable in the current runtime. The service status projection is enough for this design
  pass, but deployers need an approved read-only evidence path before incident response depends on database-level facts.
