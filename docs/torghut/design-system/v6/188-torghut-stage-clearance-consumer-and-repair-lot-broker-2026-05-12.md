# 188. Torghut Stage-Clearance Consumer And Repair-Lot Broker (2026-05-12)

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

I am selecting a **stage-clearance consumer and repair-lot broker** as Torghut's next profitability architecture step.

The May 12 evidence says Torghut should not widen paper or live capital, but it should become much sharper about which
zero-notional repairs Jangar is allowed to launch. Torghut `/healthz` returned HTTP 200, `/readyz` returned degraded,
Argo marked `torghut` Degraded and `torghut-options` Progressing, and four Torghut pods were in `ImagePullBackOff`.
The database schema was current at `0031_autoresearch_candidate_spec_epoch_uniqueness`, Postgres and ClickHouse were
healthy, and market data dependencies were reachable. The capital gates still held: live submission was disabled,
proof floor was `repair_only`, max notional was `0`, empirical jobs were stale, promotion tables were thin, and quant
ingestion lag was still severe.

The source contract is also clear. `services/torghut/app/trading/profit_signal_quorum.py` already treats missing
Jangar stage clearance as a blocker and asks for `publish_current_jangar_stage_clearance_packet`. That is the right
dependency. The missing piece is a broker that maps Torghut repair evidence into Jangar repair-run lots and refuses to
upgrade paper/live when clearance is missing, stale, or narrower than the requested action.

The decision is that Torghut should consume Jangar `stage_clearance_packet` refs and publish a `repair_lot_broker`
payload. The broker ranks zero-notional lots by value-gate movement and records which Jangar packet or repair lot is
required before dispatch. It does not make Jangar the capital source of truth. Torghut remains the capital authority;
Jangar owns launch custody.

The tradeoff is that Torghut will expose more negative evidence and more explicit "not paper yet" decisions. That is
the right tradeoff. Profitability improves when the system spends scarce repair cycles on lots that can move
routeability, TCA, market context, empirical proof, or promotion custody instead of launching more unfocused runs.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-12. I did not mutate Kubernetes resources, database rows, trading
flags, broker state, GitOps resources, or AgentRun objects.

### Cluster And Runtime

- Argo CD reported `torghut` as `Synced/Degraded` at revision `32564cef018d608a7928c80240a70d35f75c5b25`.
- Argo CD reported `torghut-options` as `Synced/Progressing` at revision
  `d875cca7addce4a02afd5bb005b26636960f8c35`.
- Torghut namespace pod phases were `17 Running` and `4 ImagePullBackOff`.
- `torghut-ws`, `torghut-ws-options`, `torghut-options-ta`, and `torghut-ta-sim` were in image-pull backoff.
- The current Torghut live revision was `torghut-00320`; the sim revision was `torghut-sim-00418`.
- `/healthz` returned HTTP 200 with service status OK.
- `/readyz` returned `status=degraded`.
- `/db-check` returned `ok=true`, schema current, lineage ready, and expected/current head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- CNPG direct SQL and secret listing were forbidden to the assessing service account, so application database proofs
  are the allowed database evidence surface for this run.

### Data And Capital Evidence

- Live submission was blocked by `simple_submit_disabled`, `hypothesis_not_promotion_eligible`, and
  `empirical_jobs_not_ready`.
- Profitability proof floor was `repair_only`, `capital_state=zero_notional`, and `max_notional=0`.
- Consumer evidence produced a current receipt and a route-proven-profit repair decision with `route_repair_value=14`.
- Empirical jobs were completed but stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.
- Forecast service was degraded because the registry was empty.
- Quant latest metrics reported `180` rows and fresh update timestamps, but ingestion lag remained roughly `956708`,
  `349084`, and `341406` seconds for three strategies.
- Market context had a fresh `AMZN` bundle and healthy providers, but technicals, fundamentals, and regime domains
  were stale.
- Route/TCA data was mixed: one symbol was probing, four were blocked by route-universe exclusions, and three were
  missing symbol-level execution evidence.
- Promotion evidence remained insufficient: zero research candidates, zero research promotions, one strategy
  promotion decision, and zero vnext promotion decisions.

### Source And Test Surface

- `profit_signal_quorum.py` already models Jangar stage clearance and produces
  `stage_clearance_packet_missing`.
- `services/torghut/app/main.py` builds a Jangar stage-clearance packet ref from dependency quorum, but the live
  Jangar status route currently emits no `stage_clearance_packet`.
- `consumer_evidence.py`, `profit_repair_settlement.py`, `profit_windows.py`, `profit_leases.py`,
  `route_reacquisition.py`, and `profit_signal_quorum.py` are the right pure-module inputs for a repair-lot broker.
- `services/torghut/app/main.py` is 5,298 lines and should stay a route assembler rather than absorbing repair-lot
  scoring.
- Existing tests cover consumer evidence, profit windows, and profit-signal quorum. The missing tests are broker
  invariants: missing Jangar clearance blocks paper/live, stale clearance allows only zero-notional repair lots, and
  selected lots must name a target value gate.

## Problem

Torghut has enough proof surfaces to explain why capital is held. It does not yet turn those proof surfaces into a
launch contract that Jangar can enforce.

The failure modes are concrete:

1. A current consumer-evidence receipt can be mistaken for paper readiness.
2. A route-proven repair decision can be mistaken for routeable capital.
3. Fresh quant latest metrics can hide stale ingestion and materialization stages.
4. Completed empirical jobs can be stale enough to block promotion but still look successful.
5. Missing Jangar stage clearance appears as one readiness reason instead of a hard cross-plane packet requirement.
6. Repair launches can spend runtime without declaring whether they target routeability, stale-evidence rate, TCA
   quality, promotion evidence, or capital safety.

## Alternatives Considered

### Option A: Let Jangar Own Repair Ranking

Jangar would read Torghut evidence and decide which repair lot should run next.

Advantages:

- One scheduler-local admission path.
- Easy for Jangar to deny uncited launches.
- Keeps scheduling and repair prioritization together.

Disadvantages:

- Puts trading-domain value scoring in the control plane.
- Risks stale or partial interpretation of Torghut proof payloads.
- Makes Jangar a capital-adjacent ranking authority instead of a launch authority.

Decision: reject. Jangar should enforce launch custody; Torghut should rank trading repair value.

### Option B: Keep Torghut Repair Lists Internal

Torghut would keep exposing readiness and consumer evidence, and Jangar would continue using broad action verdicts.

Advantages:

- Lowest implementation cost.
- Avoids another response payload.
- Keeps current capital safety behavior unchanged.

Disadvantages:

- Does not close the missing stage-clearance packet dependency.
- Keeps Jangar unable to distinguish valuable zero-notional repair from audit-volume runs.
- Leaves paper/live denial spread across many payloads instead of a compact broker answer.

Decision: reject. The current state is safe for capital but inefficient for repair.

### Option C: Stage-Clearance Consumer With Repair-Lot Broker

Torghut consumes Jangar packets and publishes selected zero-notional repair lots ranked by value gate. Jangar may
launch only lots whose required packet or repair ref is current.

Advantages:

- Keeps Torghut as the trading-value and capital-safety authority.
- Gives Jangar the compact lot refs needed to reduce failed or unfocused AgentRuns.
- Preserves zero-notional safety while increasing useful proof production.
- Turns missing Jangar clearance into a first-class broker state.
- Maps repair work to measurable gates: routeability, stale-evidence rate, TCA quality, promotion custody, and
  capital safety.

Disadvantages:

- Adds one broker payload to readiness/status surfaces.
- Requires cross-service versioning with the Jangar stage-clearance packet.
- May reduce repair dispatch until schedules cite lots correctly.

Decision: select Option C.

## Architecture

Torghut publishes a compact `repair_lot_broker` payload:

```text
repair_lot_broker
  schema_version
  broker_id
  generated_at
  fresh_until
  account
  window
  jangar_stage_clearance_ref
  jangar_repair_run_lot_refs[]
  broker_decision              # observe_only | repair_only | hold | block
  paper_candidate_allowed
  live_action_allowed
  max_notional
  selected_lots[]
  held_lots[]
  rejected_lots[]
  capital_safety_ref
  blocking_reason_codes[]
```

Each `selected_lot` contains:

```text
torghut_repair_lot
  lot_id
  target_value_gate
  repair_class
  symbols[]
  hypothesis_ids[]
  expected_unblock_value
  expected_cost_class
  required_jangar_packet_ref
  required_input_receipts[]
  required_output_receipts[]
  max_runtime_seconds
  max_notional
  stop_conditions[]
  rollback_target
```

Initial target value gates:

- `routeable_candidate_count`
- `zero_notional_or_stale_evidence_rate`
- `fill_tca_or_slippage_quality`
- `promotion_evidence_depth`
- `capital_gate_safety`
- `pr_to_rollout_latency`
- `failed_agentrun_rate`

Initial repair classes:

- `market_context_domain_refresh`
- `quant_ingestion_repair`
- `empirical_job_refresh`
- `route_tca_symbol_probe`
- `promotion_candidate_generation`
- `forecast_registry_repair`
- `image_digest_reconcile`
- `stage_clearance_packet_publish`

Rules:

- `max_notional` is `0` while proof floor is `repair_only`, live submission is disabled, or Jangar paper/live
  clearance is absent.
- Missing Jangar clearance sets `broker_decision=repair_only` at most and selects only the
  `stage_clearance_packet_publish` or diagnostics lots.
- A current Jangar read-only or observe packet cannot upgrade paper.
- A lot without a target value gate is audit work and cannot be selected by the broker.
- A paper candidate requires current Jangar paper clearance, proof floor not repair-only, live submission policy
  compatible with paper, non-empty promotion evidence, fresh enough market context, acceptable route/TCA, and current
  quant ingestion.
- Live action requires the paper criteria plus live submission authorization and an explicit capital safety receipt.

## Implementation Scope

Engineer milestone 1:

- Add a pure broker reducer under `services/torghut/app/trading/repair_lot_broker.py`.
- Feed it from consumer evidence, proof floor, profit repair settlement, route reacquisition, quant evidence, market
  context, empirical jobs, forecast service, promotion evidence, and Jangar stage-clearance refs.
- Expose a compact broker summary in `/readyz`, `/trading/status`, and `/trading/consumer-evidence`.
- Keep `main.py` as an assembler; do not add scoring logic there.

Engineer milestone 2:

- Add tests where Jangar clearance is missing and broker selects only a stage-clearance repair lot with
  `max_notional=0`.
- Add tests where route/TCA has one probing symbol but paper remains blocked because proof floor is repair-only.
- Add tests where stale empirical jobs select an empirical refresh lot but do not change live submission.
- Add tests where a lot without a target value gate is rejected.

Jangar integration milestone:

- Consume broker selected lots in the Jangar repair-run lot ledger.
- Require scheduled Torghut repair AgentRuns to cite a selected broker lot and a current Jangar repair-run lot.
- Keep paper/live blocked when broker payload is absent, stale, or narrower than the requested action class.

## Validation Gates

- `failed_agentrun_rate`: Jangar should launch only selected lots with bounded runtime and current packet refs; Torghut
  should expose rejected lots so duplicate or value-less repair runs are denied.
- `pr_to_rollout_latency`: image and rollout repair lots must carry digest/revision refs and expected deployer
  verification commands.
- `ready_status_truth`: `/healthz=ok` and current consumer evidence do not imply paper/live readiness; broker state
  must show repair-only or hold while proof floor and Jangar clearance are not current.
- `manual_intervention_count`: held lots must name the missing receipt or packet rather than requiring operators to
  compare readiness payloads manually.
- `handoff_evidence_quality`: every Torghut repair, paper, or live implementation PR must cite the broker lot id,
  target value gate, and expected output receipt.

## Rollout

1. Ship the broker reducer in observe mode and expose compact payloads without changing capital behavior.
2. Compare selected lots with current proof-floor repair ladder and Jangar material action verdicts for one market
   session.
3. Let Jangar ingest selected lots into its repair-run lot ledger.
4. Require broker lot refs for scheduled Torghut repair AgentRuns.
5. Keep paper/live blocked until Jangar stage clearance, proof floor, promotion evidence, route/TCA, market context,
   quant ingestion, and live submission policy converge.

## Rollback

- Stop Jangar enforcement of broker lots and keep the payload visible in observe mode.
- Keep proof floor, live submission gate, route/TCA exclusions, and existing consumer evidence as the safety boundary.
- If the broker payload is stale or malformed, Torghut returns `broker_decision=hold` for paper/live and
  `repair_only` only for diagnostics.
- Do not enable paper/live, widen notional, loosen slippage, or bypass proof floor as a rollback.

## Risks And Tradeoffs

- Scoring bias: the broker can over-rank easy repairs. Mitigation: require target value gates and output receipts.
- Payload growth: readiness is already large. Mitigation: compact summary in `/readyz`, fuller lot detail in
  `/trading/status` and `/trading/consumer-evidence`.
- Cross-plane latency: Jangar packets may expire during a market session. Mitigation: fail closed for capital and
  allow only bounded zero-notional refresh lots.
- Launch reduction: fewer repair jobs may run initially. Mitigation: selected lots should have higher proof yield and
  lower failed-run rate.

## Handoff

Engineer handoff: implement `repair_lot_broker.py` as a pure reducer, expose compact broker payloads, and add tests for
missing Jangar clearance, repair-only proof floor, stale empirical jobs, and unscored lots. The first implementation
must prove that no broker output can authorize paper/live while Jangar clearance is missing or proof floor remains
repair-only.

Deployer handoff: deploy observe-only first. Acceptance requires `/readyz`, `/trading/status`, and
`/trading/consumer-evidence` to show broker state, selected zero-notional lots, current or missing Jangar clearance
refs, unchanged `max_notional=0`, and no live submission while proof floor is repair-only.
