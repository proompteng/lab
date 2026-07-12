# 188. Torghut Route-Evidence Clearinghouse And Execution-Freshness Market (2026-05-12)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Decision

I am selecting a **route-evidence clearinghouse with an execution-freshness market** as Torghut's next architecture
layer.

The May 8 routeability and profit-window decisions were directionally right, but the May 12 evidence says the system
still lacks a single place where fresh data, active fill proof, deployability, and capital authority settle into one
routeable answer. Torghut has data volume: Postgres holds `147666` `trade_decisions`, `13775`
`execution_tca_metrics`, and `2442749` option contracts. That volume is not translating into routeable profit
evidence. The newest trade decision is `2026-05-08T17:29:45Z`, there are `0` decisions in the last day, newest TCA is
`2026-05-08T02:38:30Z`, newest execution creation is `2026-04-02T20:59:45Z`, and `/trading/status` still reports
`routeable_candidate_count=0` with `routeability_acceptance_ledger=null`.

The live cluster shows the other half of the problem. `torghut` is `Synced/Degraded` and `torghut-options` is
`Synced/Progressing`. Four route-adjacent workloads are blocked by missing registry digests:
`torghut-ws`, `torghut-ws-options`, `torghut-ta-sim`, and `torghut-options-ta`. Torghut's primary service,
simulation service, live TA job manager and task managers, Postgres, ClickHouse, options catalog, and options enricher
are running, but deployability is not clean enough to treat data freshness as production proof. `/readyz` is
`degraded`; Postgres, ClickHouse, Alpaca broker, schema, universe, and current quant latest metrics are acceptable,
while `live_submission_gate.ok=false`, `profitability_proof_floor.ok=false`, and the proof floor remains
`capital_state=zero_notional`.

The selected design adds a clearinghouse packet that prices every route claim against five ledgers: source freshness,
execution freshness, rollout image proof, profit-window custody, and capital holds. Torghut remains capital authority.
Jangar consumes the companion rollout escrow to decide which repair work is worth launching. Paper and live admission
stay blocked until the clearinghouse settles current route evidence.

The tradeoff is that routeable candidate count may stay at zero while repair work becomes more selective. I accept
that. A large options catalog, a green service, or historical TCA is not a profitable route. A route becomes valuable
when it has fresh source data, current fill-quality proof, a deployable image path, and a capital-safe receipt.

## Evidence Snapshot

All evidence below was collected for assessment. Kubernetes and database assessment were intended to be read-only.
Database content was queried through app credentials with read-only SQL statements; no rows were intentionally
inserted, updated, deleted, or backfilled.

### Cluster And Rollout

- Local branch is `codex/swarm-torghut-quant-discover` based on `origin/main` at
  `32564cef018d608a7928c80240a70d35f75c5b25`.
- In-cluster Kubernetes auth is `system:serviceaccount:agents:agents-sa`.
- Argo applications show `agents`, `agents-ci`, `jangar`, `kafka`, `nats`, `symphony-jangar`, and
  `symphony-torghut` as `Synced/Healthy`.
- Argo reports `torghut` as `Synced/Degraded` and `torghut-options` as `Synced/Progressing`.
- Torghut running workloads include `torghut-00320`, `torghut-sim-00418`, `torghut-ta`, four live TA task managers,
  `torghut-db-1`, ClickHouse, Keeper, options catalog, options enricher, guardrail exporters, and alloy.
- The current degraded route-adjacent pods are missing registry digests:
  - `torghut-ws@sha256:67f4c169...` is `ImagePullBackOff`.
  - `torghut-ws-options@sha256:67f4c169...` is `ImagePullBackOff`.
  - `torghut-ta-sim@sha256:20fe1818...` is `ImagePullBackOff`.
  - `torghut-options-ta@sha256:c1c7b855...` is `ImagePullBackOff`.
- Torghut recent events show successful DB migrations and whitepaper/bootstrap jobs, live TA reaching `RUNNING`, and
  repeated backoff events for the missing WebSocket and TA simulation digests.
- Jangar is running and leader-elected. `/ready` returns `status=ok`, but `execution_trust.status=degraded` because
  swarm freeze/stage staleness holds discover, plan, implement, and verify.
- Agents controllers are `2/2` and current heartbeats in Jangar DB are healthy, but the agents namespace retains
  failed schedule and market-context pods. Recent events include `BackoffLimitExceeded` for AMZN/INTC fundamentals and
  news repair jobs.

### Runtime

- `http://torghut.torghut.svc.cluster.local/healthz` returns HTTP 200 with `status=ok`.
- `/readyz` returns `status=degraded`.
- `/readyz` dependencies show Postgres OK, ClickHouse OK, Alpaca broker OK, schema head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, static universe loaded with `8` symbols, and quant evidence
  optional but reporting `quant_metrics_update_missing`.
- `/readyz` also reports `live_submission_gate.ok=false`, `detail=simple_submit_disabled`, `capital_stage=shadow`,
  and `profitability_proof_floor.ok=false`, `detail=repair_only`, `capital_state=zero_notional`.
- `/trading/status` reports `mode=live`, `running=true`, three observe-only quorums, three zero-notional quorums,
  `paper_candidate_count=0`, `routeable_candidate_count=0`, and `blocked_or_stale_evidence_count=20`.
- `/trading/status`, `/trading/revenue-repair`, and `/trading/consumer-evidence` do not yet expose a live
  `routeability_acceptance_ledger`.
- `/trading/revenue-repair` reports `business_state=repair_only` and `revenue_ready=false`.

### Database And Data Quality

- Torghut Postgres schema is current at Alembic head `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- Key Torghut counts:
  - `trade_decisions=147666`, newest `created_at=2026-05-08T17:29:45Z`, `0` rows in the last day.
  - `executions=13778`, newest `created_at=2026-04-02T20:59:45Z`.
  - `execution_tca_metrics=13775`, newest `updated_at=2026-05-08T02:38:30Z`.
  - `vnext_empirical_job_runs=28`, newest `updated_at=2026-05-08T21:54:41Z`.
  - `strategy_hypotheses=1`, `strategy_promotion_decisions=1`, `strategy_capital_allocations=1`.
  - `evidence_epochs=0`, `evidence_receipts=0`, `simulation_run_progress=0`.
- Options catalog quality:
  - `2442749` contracts across `5966` underlyings.
  - `2402298` contracts marked tradable.
  - `1101383` contracts missing `close_price`.
  - `1206699` contracts have zero open interest.
  - `2442749` contracts have missing `provider_updated_ts`.
  - `newest_last_seen=2026-05-12T16:00:45Z`, newest `close_price_date=2026-05-11`, newest
    `open_interest_date=2026-05-08`.
- Jangar DB is current enough to supervise repair:
  - `agents_control_plane.component_heartbeats` has healthy enabled rows for agents, orchestration, supporting, and
    workflow runtime controllers at `2026-05-12T16:31:38Z`.
  - `torghut_control_plane.quant_metrics_latest` has `4536` rows with newest `updated_at=2026-05-12T16:31:38Z`.
  - `workflow_comms.agent_messages` has `21057` rows with newest `created_at=2026-05-12T16:31:30Z`.
  - `memories.entries` has `1176` rows, but the repo memory helper returned HTTP 500 during this run with
    `retrieve memories failed: Unable to connect`.

### Source And Test Surface

- `services/torghut/app/main.py` is `5298` lines and should not absorb another scoring branch.
- The clearinghouse should be implemented as pure reducers near existing proof producers:
  `proof_floor.py`, `profit_signal_quorum.py`, `profit_repair_settlement.py`, `route_reacquisition.py`,
  `route_reacquisition_board.py`, `profit_windows.py`, `quality_adjusted_profit_frontier.py`, `tca.py`, and
  `options_lane/repository.py`.
- `services/torghut/app/trading/research_sleeves.py` is `5254` lines, `decisions.py` is `3349` lines, and
  `strategy_runtime.py` is `2425` lines. The implementation should not widen those hot files unless the reducer
  boundary requires it.
- Existing tests cover proof-floor TCA blockers, route reacquisition, profit repair settlement, profit signal quorum,
  profit windows, options lane catalog persistence, and trading readiness.
- Missing tests are cross-plane invariants:
  - A fresh options `last_seen_ts` with missing `provider_updated_ts` cannot unlock options routeability.
  - A route with historical TCA and no active-session executions cannot become paper eligible.
  - A route claim cannot pass while any required image digest is missing from the registry.
  - Jangar may dispatch zero-notional repair, but cannot convert a repair receipt into paper/live capital.

## Problem

Torghut has several proof surfaces, but no authoritative exchange where they clear against each other.

That creates six concrete failure modes:

1. Fresh options catalog ingestion can look like tradable alpha even when provider update clocks are absent.
2. Historical TCA can look like fill-quality proof even when active-session executions are stale.
3. Healthy core services can hide route-adjacent image promotion failures.
4. A profit-window repair market can rank repairs without pricing the image and data defects that prevent rollout.
5. Jangar can launch repair jobs that create evidence volume without retiring a value gate.
6. Operators can see `healthz=ok`, fresh quant latest metrics, and millions of options rows, then overread that state
   as routeable post-cost profit evidence.

The system needs a clearinghouse that makes the strongest negative evidence easy to consume and impossible to bypass.

## Alternatives Considered

### Option A: Fix Image Promotion First And Freeze Quant Architecture

Repair the missing `torghut-ws`, `torghut-ws-options`, `torghut-ta-sim`, and `torghut-options-ta` digests before doing
anything else.

Advantages:

- Directly addresses the current Argo degraded/progressing state.
- Gives deployers an obvious first repair.
- Reduces false confidence from partially available workloads.

Disadvantages:

- Does not explain why `147666` trade decisions and `13775` TCA rows still produce zero routeable candidates.
- Does not price options data quality defects.
- Does not tell Jangar which zero-notional repair work should run after images pull.

Decision: reject as the architecture. It is a required repair lot inside the selected clearinghouse.

### Option B: Push Options Alpha From The Fresh Catalog

Use the large options catalog as the next profit wedge and build options route candidates around tradable contracts
with current `last_seen_ts`.

Advantages:

- The catalog is large and current by ingestion time.
- Options can improve routeable candidate count faster than waiting for equity fill proof.
- The existing options catalog/enricher pods are running.

Disadvantages:

- Every catalog row is missing `provider_updated_ts`.
- About `45%` of rows are missing close price, and about `49%` have zero open interest.
- Options TA and TA-sim route surfaces include current image-pull failures.
- It would convert data volume into strategy confidence before source and execution clocks settle.

Decision: reject for paper/live admission. Keep options as a high-value repair lane.

### Option C: Route-Evidence Clearinghouse With Execution-Freshness Market

Settle every route claim through a clearinghouse packet that prices source freshness, active-session fill quality,
rollout image proof, profit-window custody, and capital holds. Let Jangar launch only zero-notional repair bids that
name the lot and value gate they retire.

Advantages:

- Converts the current evidence into a ranked repair market instead of another health dashboard.
- Keeps Torghut capital authority intact while giving Jangar a precise dispatch contract.
- Separates data freshness from routeability and routeability from paper/live capital.
- Directly maps to the swarm value gates: `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`,
  `fill_tca_or_slippage_quality`, `capital_gate_safety`, and later `post_cost_daily_net_pnl`.
- Makes image promotion proof a first-class precondition for route claims.

Disadvantages:

- Adds one more versioned packet and reducer.
- Requires consistent clocks across options, equity routes, TCA, and Jangar quant projections.
- Keeps near-term routeable count conservative while repair lots settle.

Decision: select Option C.

## Architecture

Torghut publishes a versioned `route_evidence_clearinghouse_packet`:

```text
route_evidence_clearinghouse_packet
  schema_version
  generated_at
  fresh_until
  account_id
  session_id
  torghut_revision
  source_commit
  torghut_image_proof_ref
  routeability_acceptance_ledger_ref
  profit_window_custody_ref
  proof_floor_ref
  source_freshness_book_ref
  execution_freshness_book_ref
  rollout_image_book_ref
  capital_hold_book_ref
  repair_bid_book_ref
  route_claims[]
  selected_repair_bids[]
  held_action_classes[]
  accepted_routeable_candidate_count
  zero_notional_or_stale_evidence_rate
  fill_tca_or_slippage_quality
  capital_decision
  rollback_target
```

Each `route_claim` contains:

```text
route_claim
  route_id
  hypothesis_id
  symbols[]
  asset_class
  source_freshness_decision
  execution_freshness_decision
  rollout_image_decision
  profit_window_decision
  capital_decision
  post_cost_edge_estimate
  expected_repair_value
  routeability_decision       # accepted | repair_only | hold | block
  max_notional
  reason_codes[]
```

The clearinghouse owns five ledgers:

- `source_freshness_book`: provider timestamps, close price coverage, open-interest coverage, quote/bar coverage, and
  Jangar quant projection clocks.
- `execution_freshness_book`: active-session executions, TCA recency, route sample coverage, slippage distribution,
  route sample symbols, and missing route sample symbols.
- `rollout_image_book`: image digest resolution, workload availability, Argo health, and rollback digest.
- `capital_hold_book`: proof floor, submit gate, profit-window custody, warrant/capital decision, and notional cap.
- `repair_bid_book`: repair lots ranked by value gate retired, expected unblock value, cost class, and required output
  receipt.

Clearing rules:

- `routeable_candidate_count` can increase only from a clearinghouse `route_claim` with
  `routeability_decision=accepted`.
- `accepted` requires fresh source clocks, active-session fill/TCA proof, resolved image digests for route-adjacent
  workloads, non-quarantined profit-window custody, and Torghut capital safety.
- Options routes cannot be accepted while `provider_updated_ts` is missing for the supporting source set.
- Equity or options routes cannot be accepted from TCA older than the active session budget.
- Argo `Synced` or service `healthz=ok` cannot override an unresolved image digest.
- Jangar repair dispatch can be allowed only when the bid names one clearinghouse lot and one value gate.
- Paper/live notional remains `0` while `profitability_proof_floor=repair_only`, `simple_submit_disabled`, or the
  clearinghouse capital decision is `repair_only`, `hold`, or `block`.

## Measurable Trading Hypotheses

Hypothesis 1: options source-clock repair has positive routeability value.

- Repair: populate provider update clocks or an equivalent attested source timestamp for option contracts.
- Guardrail: no paper/live admission until close price coverage, open-interest coverage, and route image proof settle.
- Metric: reduce `zero_notional_or_stale_evidence_rate`; candidate routeability remains zero until execution proof
  settles.

Hypothesis 2: active-session TCA repair is the highest-value equity repair.

- Repair: generate bounded zero-notional route probes or replay receipts for symbols missing current fill proof.
- Guardrail: probes cannot loosen slippage thresholds or submit live notional.
- Metric: improve `fill_tca_or_slippage_quality`; route claims remain held if newest execution/TCA is outside the
  active-session budget.

Hypothesis 3: image promotion proof is a prerequisite to options route evidence.

- Repair: republish or roll back the missing `torghut-ws`, `torghut-ws-options`, `torghut-ta-sim`, and
  `torghut-options-ta` digests.
- Guardrail: clearinghouse marks route-adjacent claims `hold:image_digest_unresolved` until pods pull.
- Metric: reduce rollout-induced stale evidence and unblock deployer verification.

Hypothesis 4: repair bids beat broad dispatch.

- Repair: Jangar launches only bids that cite a clearinghouse lot, value gate, expected unblock value, and output
  receipt.
- Guardrail: dispatch success cannot upgrade capital; Torghut clearinghouse remains the route authority.
- Metric: fewer failed or irrelevant proof runs, lower stale-evidence rate, and eventually higher routeable candidate
  count after settled receipts.

## Implementation Scope

Engineer milestone 1: add the Torghut clearinghouse reducer in observe mode.

- Inputs: proof floor, profit signal quorum, profit repair settlement, route reacquisition board, profit-window
  custody, TCA summary, options catalog freshness summary, and image proof summary.
- Output: `route_evidence_clearinghouse_packet` in `/readyz`, `/trading/status`, `/trading/revenue-repair`, and
  `/trading/consumer-evidence`.
- Value gates: `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, `capital_gate_safety`.

Engineer milestone 2: implement repair bids.

- Add source-clock, execution-freshness, image-promotion, and capital-hold repair bid generation.
- Keep all bids zero-notional until clearinghouse acceptance.
- Value gates: `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`,
  `fill_tca_or_slippage_quality`.

Engineer milestone 3: wire Jangar through the companion rollout escrow.

- Jangar consumes the clearinghouse packet for dispatch, deploy, and Torghut action admission.
- Jangar may launch repair bids only when a lot and value gate are cited.
- Value gates: `capital_gate_safety`, `zero_notional_or_stale_evidence_rate`.

Deployer milestone:

- Prove Argo sync, image digest pullability, Torghut `/readyz`, clearinghouse packet presence, Jangar rollout escrow
  presence, and no paper/live widening.
- Capture rollback digests before enabling enforcement.

## Validation Gates

- `post_cost_daily_net_pnl`: no claimed improvement until paper/live post-cost receipts exist after clearinghouse
  acceptance.
- `routeable_candidate_count`: can increase only from accepted clearinghouse route claims, never from data count,
  service health, or Jangar dispatch.
- `zero_notional_or_stale_evidence_rate`: every held route claim must name the stale lot and next repair bid.
- `fill_tca_or_slippage_quality`: active-session TCA and route samples are required; historical TCA is repair
  evidence only.
- `capital_gate_safety`: `simple_submit_disabled`, `profitability_proof_floor=repair_only`, missing warrants, or
  unresolved image proof keep notional at zero.

## Rollout

1. Ship clearinghouse packet in observe mode with no admission effects.
2. Compare packet decisions against `/readyz`, `/trading/status`, route reacquisition, profit repair settlement, and
   Jangar consumer evidence for one market session.
3. Enable Jangar repair-bid admission while paper/live remains held.
4. Enforce route claim holds for unresolved source clocks, stale TCA, missing images, and capital holds.
5. Permit paper canaries only after current execution freshness, image proof, source freshness, profit-window custody,
   and capital receipts settle.

## Rollback

- Disable clearinghouse enforcement and keep the packet observe-only.
- Keep Torghut proof floor and submit gate as the capital backstop.
- Hold all options route claims if options image proof or provider source clocks regress.
- Hold all equity route claims if active-session TCA regresses.
- Do not loosen slippage thresholds, freshness budgets, warrant requirements, or notional caps as rollback.

## Risks

- The options catalog is large enough that naive exact counts can be expensive. The implementation should materialize
  bounded freshness summaries instead of scanning the full table on hot paths.
- Image promotion state can change faster than route evidence. The rollout image book needs short TTLs and a rollback
  digest.
- Jangar stage staleness can hold useful repair dispatch. The companion escrow must allow bounded zero-notional
  repair while still blocking paper/live and routeability claims.
- Provider clocks may be unavailable from the upstream API for some contracts. If so, the engineer must define an
  equivalent attested ingestion clock and keep it distinct from provider truth.

## Handoff

Engineer:

- Build the clearinghouse as a pure Torghut reducer and expose it in existing trading payloads.
- Add regression tests for options source-clock holds, historical TCA holds, missing image holds, and zero-notional
  capital safety.
- Do not change live submission defaults or notional caps while adding the packet.

Implementation note (2026-05-12):

- The first implementation cut adds `services/torghut/app/trading/route_evidence_clearinghouse.py` as a pure
  observe-mode reducer and wires `route_evidence_clearinghouse_packet` into the four milestone response surfaces.
- The reducer keeps `max_notional=0`, accepts only fully settled route claims, and emits zero-notional repair bids for
  stale source, execution, image, routeability, and capital evidence.
- Options provider-clock holds are scoped to the candidate's supporting source evidence when present. Catalog-wide
  provider timestamp gaps remain visible as source-book background defects, but unrelated stale contracts do not hold a
  route claim with fresh scoped source proof.
- Regression tests cover missing options provider clocks, historical TCA, unresolved image proof, and capital holds.

Deployer:

- Do not enable enforcement until image pull failures are resolved or rolled back and the clearinghouse packet is
  visible in live Torghut payloads.
- Verify Jangar rollout escrow consumes the packet and still holds paper/live action classes.
- Final rollout evidence must name the revenue metric improved or the smallest blocker preventing revenue impact.
