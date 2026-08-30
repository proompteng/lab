# 187. Torghut Profit-Window Custody And Repair-Value Market (2026-05-08)

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

I am selecting a **profit-window custody and repair-value market** as Torghut's next profitability architecture step.

The current live state is not a capital-release state. Torghut `/healthz` returned HTTP 200, but `/readyz` returned
HTTP 503 with `status=degraded`. Postgres, ClickHouse, schema lineage, and empirical jobs were healthy, but
`live_submission_gate.ok=false`, `profitability_proof_floor.ok=false`, `capital_state=zero_notional`, and
`simple_submit_disabled` remained active. Jangar consumed a current Torghut consumer-evidence receipt, but that receipt
still reported `decision=repair`, `max_notional=0`, and blockers including `forecast_registry_degraded`,
`simple_submit_disabled`, `hypothesis_not_promotion_eligible`, and `market_context_stale`.

The profitable opportunity is not to widen notional. It is to spend repair effort where it has measurable expected
unblock value. The live readiness payload already exposes useful ingredients: profit windows, profit leases, consumer
evidence, route-proven profit receipts, capital reentry cohorts, and profit repair lots. The missing piece is a
market-like admission layer that ranks repair work by the value gate it can retire and returns an explicit "not yet
paper" decision to Jangar.

The selected design keeps Torghut as the source of capital truth and asks Jangar to enforce action custody. Torghut
publishes `profit_window_custody` and `repair_value_market` payloads. Jangar consumes them through the companion
`action_custody_receipt`. Paper and live remain held until a profit window is funded, route/TCA evidence is current,
market context is fresh, schema lineage is present, promotion evidence is non-empty, and Jangar custody is fresh.

The tradeoff is that Torghut will make some repair priorities more explicit and therefore easier to challenge. That is
the right tradeoff. A zero-notional platform with stale evidence should optimize proof repair ROI before it optimizes
order flow.

## Evidence Snapshot

All evidence below was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps resources, or AgentRun objects.

### Cluster And Runtime

- Argo CD reported `torghut` and `torghut-options` `Synced/Healthy` at revision
  `5b5e94d175626ac94d4ea3c5d9152522824e2bd3`.
- Torghut live pod `torghut-00311-deployment-59b74ddc99-8vhdk` and sim pod
  `torghut-sim-00409-deployment-5b8b455c84-t52lm` were running.
- ClickHouse, Keeper, Torghut DB, Torghut TA, Torghut TA sim, options TA, WebSocket, options catalog, and options
  enricher pods were running.
- Recent Torghut events still showed ClickHouse multiple-PDB warnings, a no-pods keeper PDB warning, and Torghut
  WebSocket readiness probe failures.
- `/healthz` returned HTTP 200 with `{"status":"ok","service":"torghut"}`.
- `/readyz` returned HTTP 503 and `status=degraded`.
- `/readyz` dependencies showed Postgres OK, ClickHouse OK, Alpaca broker OK, database schema current at
  `0030_evidence_epochs`, empirical jobs healthy, and universe loaded.
- `/readyz` also showed `live_submission_gate.ok=false`, `profitability_proof_floor.ok=false`, and quant evidence
  `status=degraded`.

### Data And Profit Signals

- `live_submission_gate.allowed=false`, `reason=simple_submit_disabled`, blocked reasons
  `hypothesis_not_promotion_eligible` and `simple_submit_disabled`, `capital_stage=shadow`, and
  `capital_state=observe`.
- The proof floor was `repair_only` with `capital_state=zero_notional`.
- Quant evidence for `PA3SX7FYNUTF/15m` had `180` latest metric rows and a recent update, but also
  `quant_metrics_update_missing`, `quant_pipeline_degraded`, and ingestion lag reaching `611,186` seconds in the
  sampled `/readyz` payload.
- Market context was current at the bundle level, but domain state still included `technicals=stale`.
- Hypothesis evaluation showed:
  - `H-CONT-01`: observe/quarantined, missing window evidence, missing strategy hypothesis, `ta-core` blocked.
  - `H-MICRO-01`: shadow/underfunded, route candidate present, evidence stale, `ta-core` blocked.
  - `H-REV-01`: observe/quarantined, market-context and `ta-core` blocked, missing strategy hypothesis.
- The profit-window contract returned decisions `quarantined`, `underfunded`, and `quarantined`; all windows had
  `schema_lineage_missing`, and all included quant or market-context debt.
- The consumer-evidence receipt exposed route repair value `14`, zero capital-eligible symbols, and top repair symbols
  including `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA`.

### Database

- Torghut Postgres reads used the app credential inside `BEGIN READ ONLY`.
- `trade_decisions` had `147,650` rows with newest `created_at=2026-05-08T15:22:46Z`; newest `executed_at` remained
  `2026-04-02T20:59:45Z`.
- `execution_tca_metrics` had `13,775` rows across `12` symbols with newest `computed_at=2026-05-08T02:42:07Z`.
- `research_candidates` had `0` rows.
- `research_promotions` had `0` rows.
- `strategy_promotion_decisions` had `1` row and `0` allowed decisions.
- `vnext_promotion_decisions` had `0` rows.
- `pg_stat_user_tables` estimated only `44` live `trade_decisions` despite the exact count of `147,650`, so table stats
  are not a reliable proof-readiness source for that table.

### Source

- `services/torghut/app/main.py` is 5,298 lines and already owns many readiness, status, and consumer-evidence routes.
  It should not absorb more scoring logic.
- `services/torghut/app/trading/submission_council.py` builds `profit_window_contract` and
  `profit_lease_projection`.
- `services/torghut/app/trading/profit_windows.py`, `profit_leases.py`, `profit_signal_quorum.py`,
  `profit_repair_settlement.py`, and `consumer_evidence.py` are the right pure-module homes for the next reducers.
- Torghut has focused tests for profit windows, profit leases, profit signal quorum, profit repair settlement, consumer
  evidence, capital reentry cohorts, route reacquisition, quality-adjusted profit frontier, and trading readiness.
- The missing test surface is not another `/readyz` smoke test. It is a cross-plane invariant: a current consumer
  evidence receipt plus a Jangar read-only allow must not produce paper admission when the profit window is underfunded
  or quarantined.

## Problem

Torghut now has many proof surfaces, but it still lacks a priority market for repair capital.

The platform can say "repair only." It can also name many blockers. That is not enough for a profitable autonomous
system. Jangar needs to know which zero-notional repair work is worth launching, and Torghut needs to know which repair
proof will move a value gate rather than create more audit volume.

The failure modes are concrete:

1. A current `/trading/consumer-evidence` receipt can be mistaken for paper readiness.
2. Fresh latest quant metrics can hide stale pipeline stages and stale or missing schema lineage.
3. TCA data can exist for some symbols while route repair remains missing for others.
4. Empty research and promotion tables can be lost among larger readiness payloads.
5. Jangar can launch market-context or quant repair without a declared expected unblock value.
6. A repair run can improve evidence volume without increasing routeable candidates or lowering stale-evidence rate.

## Alternatives Considered

### Option A: Promote `H-MICRO-01` To Paper Because It Has A Candidate

Treat the microstructure candidate and current consumer-evidence route as enough to start paper canaries.

Advantages:

- Fastest route to more paper observations.
- Exercises execution and TCA paths.
- Gives the team visible progress.

Disadvantages:

- Ignores stale hypothesis evidence, `ta-core` blockage, schema lineage gaps, and zero-notional proof floor.
- Violates the capital gate by translating route presence into route readiness.
- Risks generating noisy paper outcomes that cannot be attributed to a valid profit window.

Decision: reject. A route candidate is not a funded profit window.

### Option B: Freeze All Torghut Quant Work Until `/readyz` Is Healthy

Block all quant, context, route, and promotion repair work until Torghut readiness is green.

Advantages:

- Very conservative capital posture.
- Simple operating message.
- Prevents accidental paper/live widening.

Disadvantages:

- Blocks the exact repair work needed to make `/readyz` healthy.
- Treats low-risk context refresh and high-risk capital widening as the same action.
- Increases manual intervention because operators must choose repairs outside the system.

Decision: reject as default. Keep it as an emergency posture if Jangar custody or Torghut capital gates become
untrustworthy.

### Option C: Profit-Window Custody And Repair-Value Market

Publish a custody payload per profit window and a market of repair lots ranked by expected value-gate movement. Jangar
may launch bounded zero-notional repair work only when the repair lot declares its expected unblock value, cost class,
guardrail, and required receipt.

Advantages:

- Separates repair ROI from paper/live authority.
- Lets Jangar reduce failed runs by launching only receipt-backed repair work.
- Gives Torghut a measurable path from zero-notional repair to paper readiness.
- Preserves capital safety while increasing useful evidence production.
- Maps directly to value gates: `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`,
  `fill_tca_or_slippage_quality`, and `capital_gate_safety`.

Disadvantages:

- Adds another payload to `/readyz`, `/trading/status`, and `/trading/consumer-evidence`.
- Requires careful scoring so the market does not reward cheap but irrelevant repairs.
- Requires Jangar and Torghut to agree on action-custody refs.

Decision: select Option C.

## Architecture

Torghut publishes two versioned payloads.

First, `profit_window_custody`:

```text
profit_window_custody
  schema_version
  generated_at
  fresh_until
  account
  window
  session_class
  profit_window_id
  hypothesis_id
  lane_id
  strategy_family
  custody_decision            # funded | underfunded | quarantined | blocked
  capital_decision            # observe_only | repair_only | paper_candidate | block
  max_notional
  jangar_action_custody_ref
  consumer_evidence_ref
  profit_signal_quorum_ref
  profit_lease_ref
  route_tca_ref
  market_context_ref
  schema_lineage_ref
  promotion_ref
  blocking_reason_codes[]
  required_repair_lot_ids[]
```

Second, `repair_value_market`:

```text
repair_value_market
  schema_version
  generated_at
  fresh_until
  market_id
  account
  window
  candidate_repair_lots[]
  selected_repair_lots[]
  rejected_repair_lots[]
  capital_safety_ref
```

Each repair lot contains:

```text
repair_value_lot
  lot_id
  target_value_gate
  hypothesis_id
  symbols[]
  repair_action
  expected_unblock_value
  expected_cost_class
  expected_profit_effect
  required_input_receipts[]
  required_output_receipts[]
  max_runtime_seconds
  max_notional
  stop_conditions[]
  rollback_target
```

Initial target value gates:

- `post_cost_daily_net_pnl`
- `routeable_candidate_count`
- `zero_notional_or_stale_evidence_rate`
- `fill_tca_or_slippage_quality`
- `capital_gate_safety`

Initial repair classes:

- `market_context_technicals_refresh`
- `schema_lineage_witness`
- `route_tca_symbol_probe`
- `forecast_registry_repair`
- `promotion_candidate_generation`
- `quant_pipeline_ingestion_repair`
- `rejection_drag_measurement`

Rules:

- `max_notional` stays `0` for every repair lot while proof floor is `repair_only`.
- A current Jangar `action_custody_receipt` is required before Torghut marks a window `paper_candidate`.
- A lot with no target value gate is audit work, not repair work.
- A paper candidate requires current consumer evidence, funded profit window custody, non-empty promotion evidence,
  fresh market context, acceptable route/TCA, current schema lineage, and Jangar paper custody.
- Live action requires the paper candidate criteria plus live submission gate authorization and explicit capital safety
  receipts.

## Implementation Scope

Engineer milestone 1:

- Add a pure reducer under `services/torghut/app/trading/repair_value_market.py`.
- Build `profit_window_custody` from existing profit windows, leases, consumer evidence, profit signal quorum, capital
  reentry cohorts, and Jangar continuity/custody refs.
- Expose both payloads in `/readyz`, `/trading/status`, and `/trading/consumer-evidence`.
- Keep `services/torghut/app/main.py` as a route assembler; do not add scoring logic there.

Engineer milestone 2:

- Add tests where `H-MICRO-01` has a candidate but remains `underfunded` because schema lineage or `ta-core` is
  blocked.
- Add tests where a current Jangar read-only receipt does not upgrade paper admission.
- Add tests where a selected market-context repair lot reduces `zero_notional_or_stale_evidence_rate` debt but keeps
  `max_notional=0`.

Jangar integration milestone:

- Consume `profit_window_custody` and `repair_value_market` from the companion Jangar `action_custody_receipt`.
- Require selected repair lots for Torghut repair AgentRuns.
- Block paper/live when Torghut omits a current profit-window custody ref.

## Validation Gates

- `post_cost_daily_net_pnl`: no capital widening until a funded window cites a post-cost proof ref and TCA evidence.
- `routeable_candidate_count`: selected route/TCA or promotion repair lots must declare expected candidate movement.
- `zero_notional_or_stale_evidence_rate`: market-context, schema lineage, and quant ingestion repairs must reduce named
  stale/missing evidence lots.
- `fill_tca_or_slippage_quality`: route repair lots must cite symbol-level TCA receipts or create a bounded simulation
  probe.
- `capital_gate_safety`: every repair lot keeps `max_notional=0`; paper/live require Jangar custody plus Torghut live
  submission authorization.

## Rollout

1. Ship the reducers in observe mode and expose payloads without changing submission behavior.
2. Compare selected repair lots against current `/readyz` blockers for one market session.
3. Let Jangar consume selected repair lots for zero-notional repair scheduling.
4. Require `profit_window_custody` before any paper canary claim.
5. Promote paper only after a funded window, current custody, and capital gate safety receipts converge.

## Rollback

- Remove `repair_value_market` from Jangar enforcement and keep Torghut proof floor, live submission gate, and consumer
  evidence as the safety boundary.
- Keep payloads visible in observe mode if latency is acceptable.
- Do not enable paper/live by rolling back this market. Rollback means fewer repairs are selected automatically, not
  looser capital gates.
- If the market selects irrelevant repair lots, freeze selection and require manual operator approval for repair
  classes until scoring is corrected.

## Risks And Tradeoffs

- Scoring bias: expected unblock value can over-reward easy repairs. Mitigation: require target value gates and output
  receipts, not just completed jobs.
- Payload growth: `/readyz` is already large. Mitigation: expose compact refs in readiness and full details in
  `/trading/status` or `/trading/consumer-evidence`.
- Cross-plane coupling: Jangar custody becomes part of Torghut paper admission. Mitigation: fail closed for paper/live
  and allow only zero-notional repair when custody is absent.
- Slower capital path: paper waits longer. Mitigation: the path becomes measurable: stale evidence down, routeable
  candidates up, TCA quality proven, capital safety intact.

## Handoff

Engineer handoff: implement the pure repair-value reducer and expose compact refs without adding scoring logic to
`services/torghut/app/main.py`. The first implementation must prove that a current consumer-evidence receipt and a
route candidate do not create paper admission while the profit window is underfunded and `max_notional=0`.

Deployer handoff: deploy observe-only first. Acceptance requires `/readyz`, `/trading/status`, and
`/trading/consumer-evidence` to expose current profit-window custody refs, selected zero-notional repair lots, unchanged
capital safety, and a Jangar custody ref once the companion Jangar implementation lands.
