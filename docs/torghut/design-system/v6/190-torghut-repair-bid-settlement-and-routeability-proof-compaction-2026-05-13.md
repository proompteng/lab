# 190. Torghut Repair-Bid Settlement And Routeability Proof Compaction (2026-05-13)

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

I am selecting **repair-bid settlement with routeability proof compaction** as the next Torghut architecture step.

The May 12 clearinghouse direction landed in the runtime. The live `GET /trading/revenue-repair` response now emits a
`route_evidence_clearinghouse_packet`, a `routeability-acceptance-ledger:e63fe76a33682bc1`, and zero-notional repair
bids. That is real progress. It also exposes the next bottleneck: the packet selected `55` repair bids, held
`paper_canary`, `live_micro_canary`, and `live_scale`, kept `routeable_candidate_count=0`, and reported
`zero_notional_or_stale_evidence_rate=1.0`.

The system is safe, but the repair surface is too broad to dispatch intelligently. A scheduler cannot tell whether the
next useful action is quant ingestion repair, active-session TCA refresh, rollout image proof, empirical replay, schema
lineage, drift governance, or a generic degraded-state investigation. The current packet preserves every reason, which
is good for audit, but it does not settle those reasons into a small number of executable lots with one expected output
receipt each.

The decision is to keep the existing clearinghouse as the raw evidence source and add a settlement layer beside it.
Torghut will publish a `repair_bid_settlement_ledger` and a compact `routeability_proof_compaction_packet`. The
settlement layer groups equivalent reasons, ranks lots by expected value-gate movement, assigns a dedupe key and TTL,
and selects only the bounded zero-notional lots that Jangar is allowed to dispatch. Paper and live capital stay at
`max_notional=0` until those compacted lots produce receipts and the clearinghouse re-scores routeability.

The tradeoff is that some raw blockers will stop appearing as separate dispatchable work. I accept that because the
business goal is not more repair attempts. It is routeable post-cost profit evidence and live trading readiness without
weakening capital safety.

## Read-Only Evidence Snapshot

All assessment commands were read-only. I did not mutate Kubernetes resources, database rows, GitOps resources,
ClickHouse data, broker state, trading flags, or AgentRun objects.

### Cluster And Runtime

- The local branch was `codex/swarm-torghut-quant-plan`, clean and equal to `origin/main` at
  `4ab120a6be090b217961ff1ee5768bcefaefd840`.
- Kubernetes reads used `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` was unset, but
  explicit namespace reads worked.
- Argo reported `torghut` `Synced/Degraded` at revision `4ab120a6be090b217961ff1ee5768bcefaefd840`.
- Argo reported `torghut-options` `Synced/Healthy` at revision `09a0418b8ffba3fa8e7800de201edb430d76c3e0`.
- Torghut core, sim, Postgres, ClickHouse, Keeper, TA, TA sim, options TA, WebSocket, options catalog, options
  enricher, exporters, Alloy, and Symphony pods were running.
- Recent Torghut events still showed rollout friction: startup/readiness probes returned 503 during the current
  Knative revision, ClickHouse pods matched multiple PDBs, and the Keeper PDB had no matching pods.
- `GET /healthz` returned HTTP 200 with `{"status":"ok","service":"torghut"}`.
- `GET /readyz` returned HTTP 503.
- `GET /trading/status` reported live mode and a running loop, but `live_submission_gate.allowed=false` with
  `simple_submit_disabled`, `hypothesis_not_promotion_eligible`, and `empirical_jobs_not_ready`.
- Scoped Jangar quant evidence was `status=degraded`; ingestion lag reached `985772` seconds on one strategy and
  materialization was also degraded for two strategies.
- `GET /trading/revenue-repair` reported `business_state=repair_only`, `revenue_ready=false`,
  `routeable_candidate_count=0`, `zero_notional_or_stale_evidence_rate=1.0`, and `55` selected repair bids.
- The same packet showed active execution proof stale: newest TCA computation was `2026-05-08T02:42:07Z`, newest
  execution sample was `2026-04-02T19:00:29Z`, and expected-shortfall coverage was zero.
- Jangar `/ready` returned HTTP 200, but `execution_trust.status=degraded` because Jangar and Torghut implement
  stages were stale.
- The repo memories helper returned HTTP 500 twice with `retrieve memories failed: Unable to connect`, even though
  Jangar `/ready` showed the memory provider configured and healthy.

### Source

- `services/torghut/app/trading/route_evidence_clearinghouse.py` is the correct reducer boundary and is `613` lines.
- `services/torghut/app/main.py` is `5816` lines and should not absorb settlement scoring.
- `services/torghut/app/trading/routeability_repair_acceptance.py` is `739` lines,
  `evidence_clock_arbiter.py` is `1014` lines, `proof_floor.py` is `754` lines, and
  `profit_repair_settlement.py` is `588` lines.
- `services/torghut/tests/test_route_evidence_clearinghouse.py` has focused coverage for current books,
  zero-notional behavior, and blocker-to-bid mapping, but it does not prove bid compaction, TTL expiry, or a maximum
  selected-lot count.
- The current clearinghouse maps every unique reason into one bid. That preserves fidelity but makes the dispatch
  surface grow with vocabulary rather than with independent repair work.
- The missing invariant is settlement: equivalent reasons must compact into one executable lot, each selected lot must
  name exactly one output receipt, and Jangar must not dispatch raw reason-coded bids directly.

### Database And Data

- Postgres schema head was `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- Estimated table sizes were `trade_decisions=147606`, `executions=13778`, `execution_tca_metrics=13775`, and
  `torghut_options_contract_catalog=2282001`.
- Freshness was split:
  - `trade_decisions` newest `created_at=2026-05-12 17:54:23.892633+00`;
  - `executions` newest `created_at=2026-04-02 20:59:45.104019+00`;
  - `execution_tca_metrics` newest `computed_at=2026-05-08 02:42:07.924691+00`;
  - `vnext_empirical_job_runs` newest `created_at=2026-05-08 21:54:41.117502+00`;
  - `strategy_hypothesis_metric_windows` newest `window_ended_at=2026-05-06 18:01:00+00`;
  - `strategy_promotion_decisions` newest `created_at=2026-05-06 22:34:19.476474+00`.
- Active-symbol TCA exists only for AAPL, AMD, AVGO, INTC, and NVDA. AMZN, GOOGL, and ORCL had no rows in the active
  universe query.
- Average absolute slippage was above the intended guardrail for the active proof set: AAPL `9.2512` bps, AMD
  `14.9333`, AVGO `21.8583`, INTC `20.5711`, and NVDA `13.4759`.
- There was one strategy hypothesis, three metric windows, one promotion decision, and zero allowed promotion rows.
- `vnext_empirical_job_runs` had `28` completed promotion-authority-eligible rows, but runtime classified them stale.
- `research_candidates`, `research_promotions`, `vnext_promotion_decisions`, `evidence_epochs`, `evidence_receipts`,
  and `simulation_run_progress` were empty.
- ClickHouse direct auth from this workspace failed with HTTP 403, but the guardrails exporter was reachable and
  reported both replicas up, no read-only replicated tables, disk free ratio near `0.97`, and `ta_signals` plus
  `ta_microbars` freshness at epoch `1778611720` (`2026-05-12 18:48:40 UTC`).

## Problem

Torghut can now explain why it is not routeable, but it cannot yet turn that explanation into a small, ordered repair
program.

The current failure modes are specific:

1. Fifty-five selected bids are too many for a scheduler or engineer to reason about as independent work.
2. Equivalent reasons such as stale empirical jobs, ineligible empirical jobs, and underfunded profit windows can
   launch duplicate repairs unless they settle into one lot.
3. A generic `degraded` reason can hide the precise value gate and output receipt that would retire it.
4. Jangar can dispatch a repair because a raw bid exists, even if another active run is already working the same
   evidence debt.
5. The clearinghouse can stay truthful while becoming operationally noisy.
6. Empty evidence tables and stale TCA can keep capital safe but still waste repair capacity if every symptom is
   dispatched separately.

The architecture needs a settlement contract between raw negative evidence and executable repair work.

## Alternatives Considered

### Option A: Keep The Clearinghouse Broad And Let Jangar Pick

Leave all raw reason-coded bids dispatchable and rely on Jangar scheduling policy to choose useful work.

Advantages:

- No additional Torghut reducer.
- Maximum audit fidelity.
- Fastest to wire to existing repair schedules.

Disadvantages:

- Jangar would need to understand Torghut capital semantics and reason-code equivalence.
- Duplicate repairs become likely when many symptoms share one root cause.
- Dispatch volume can rise without improving `routeable_candidate_count` or reducing stale-evidence rate.

Decision: reject. Raw evidence is not an execution plan.

### Option B: Freeze Repair Work Until The Top Blockers Are Manually Cleared

Hold all repair dispatch while operators manually fix quant ingestion, TCA refresh, image proof, empirical jobs, and
promotion custody.

Advantages:

- Strong safety posture.
- Very low chance of wasted automated repair runs.
- Easy to explain during incidents.

Disadvantages:

- Blocks the zero-notional repair work needed to retire evidence debt.
- Keeps the system dependent on human triage for every stale proof cluster.
- Does not improve the control-plane contract for the next market session.

Decision: reject as the normal posture. Keep it as an emergency brake if settlement receipts become malformed.

### Option C: Repair-Bid Settlement And Proof Compaction

Preserve raw bids for audit, but settle them into compact lots with dedupe keys, TTLs, value-gate targets, output
receipts, and dispatch limits. Jangar consumes only the compact lot tickets.

Advantages:

- Converts broad negative evidence into a bounded repair program.
- Keeps Torghut as the capital and routeability authority.
- Lets Jangar enforce launch custody without reimplementing trading logic.
- Maps every repair lot to `post_cost_daily_net_pnl`, `routeable_candidate_count`,
  `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, or `capital_gate_safety`.
- Reduces duplicate repairs while keeping audit fidelity.

Disadvantages:

- Adds one reducer and one Jangar admission object.
- Requires tests for compaction, expiry, and one-output-receipt semantics.
- May make raw dashboards look less action-rich because only compacted lots become dispatchable.

Decision: select Option C.

## Architecture

Torghut publishes `repair_bid_settlement_ledger` beside `route_evidence_clearinghouse_packet`:

```text
repair_bid_settlement_ledger
  schema_version = torghut.repair-bid-settlement-ledger.v1
  ledger_id
  generated_at
  fresh_until
  account_id
  session_id
  torghut_revision
  source_commit
  raw_clearinghouse_packet_ref
  raw_repair_bid_count
  compacted_lots[]
  selected_lot_ids[]
  held_lot_ids[]
  active_dedupe_keys[]
  routeable_candidate_count
  zero_notional_or_stale_evidence_rate
  fill_tca_or_slippage_quality
  capital_decision
  max_notional = 0
  rollback_target
```

Each compacted lot is executable only as zero-notional work:

```text
compacted_repair_lot
  lot_id
  lot_class                    # quant_pipeline | execution_tca | rollout_image | empirical_replay | promotion_custody | feature_lineage
  target_value_gate
  priority
  expected_gate_delta
  raw_reason_codes[]
  root_cause_hypothesis
  required_input_refs[]
  required_output_receipt
  validation_commands[]
  dedupe_key
  ttl_seconds
  max_runtime_seconds
  max_parallelism
  max_notional = 0
  state                        # selected | held | active | settled | expired
```

Initial lot classes:

1. `quant_pipeline`: settle scoped Jangar ingestion/materialization degradation and prove latest metrics are current.
2. `execution_tca`: refresh active-session TCA, add expected-shortfall samples, and resolve missing AMZN, GOOGL, and
   ORCL coverage before routeability can increase.
3. `rollout_image`: attach image digest and route-adjacent workload proof for the active Torghut revision.
4. `empirical_replay`: refresh stale empirical jobs and bind outputs to the active candidate and dataset snapshot.
5. `promotion_custody`: produce a current non-empty promotion custody decision before paper rehearsal.
6. `feature_lineage`: retire missing feature rows, drift checks, schema lineage, and empty research candidate tables.

Selection rules:

- Preserve every raw reason in the clearinghouse packet.
- Select at most `5` compacted lots and at most `3` Jangar-dispatchable lots per account/window.
- Never select a lot without one `required_output_receipt`.
- Never select a lot with `max_notional` above `0`.
- Hold a lot when its dedupe key is already active or its input receipts are stale.
- Treat `degraded` as non-dispatchable unless a typed lot also names the degraded source.
- Keep `routeable_candidate_count=0` until selected lots produce receipts and the clearinghouse re-scores all required
  books as current.

## Implementation Scope

Engineer milestone 1:

- Add a pure `repair_bid_settlement` reducer next to `route_evidence_clearinghouse.py`.
- Feed it only with the clearinghouse packet, routeability acceptance ledger, active run dedupe state, Jangar scoped
  quant status, and rollout image summary.
- Emit a compact settlement summary in `/readyz`, `/trading/status`, `/trading/revenue-repair`, and
  `/trading/consumer-evidence`.
- Add tests proving `55` raw bids can compact into bounded selected lots without dropping audit reason codes.
- Add tests proving no selected lot has non-zero notional or more than one required output receipt.

Engineer milestone 2:

- Add output receipt validators for `quant_pipeline`, `execution_tca`, and `rollout_image` lots.
- Add active-run dedupe keys so Jangar cannot launch duplicate repairs for one account/window/root cause.
- Add delta accounting: expected gate delta before dispatch, actual gate delta after receipt, and stale/expired
  classification when a lot does not move a value gate.

### Implementation Note (2026-05-13)

Engineer milestone 1 is implemented as an observe-mode `repair_bid_settlement` reducer in Torghut. The reducer consumes
the route-evidence clearinghouse packet plus scoped quant and rollout context, preserves raw reason codes, compacts
equivalent reasons into bounded zero-notional lots, and exposes `repair_bid_settlement_ledger` through `/readyz`,
`/trading/status`, `/trading/revenue-repair`, and `/trading/consumer-evidence`.

The initial runtime contract intentionally does not grant paper or live notional. Selected lots carry `max_notional=0`,
one `required_output_receipt`, a dedupe key, TTL, validation command, and dispatchability capped to three lots per
account/window. `routeable_candidate_count` remains zero while any compacted lot is unsettled, preserving the capital
safety gate until receipt validators land in milestone 2.

### Implementation Note (2026-05-13, Dispatch Ticket Enforcement)

Torghut now enforces the first milestone 2 receipt validator in the zero-notional repair executor. Runner-backed repairs
that require Jangar admission require a `jangar.repair-lot-dispatch-ticket.v1` proving the selected compacted lot id,
launch allowance, `max_notional=0`, dedupe key, target value gate, required output receipt, and `max_runtime_seconds`
TTL before a local runner can execute. The `/trading/profit-freshness/zero-notional-repair` POST body carries that ticket
through to the executor, and missing or mismatched tickets return a fail-closed receipt without widening capital.

## Validation Gates

Local validation for Torghut PRs:

- `pytest services/torghut/tests/test_route_evidence_clearinghouse.py`
- `pytest services/torghut/tests/test_routeability_repair_acceptance.py`
- `pytest services/torghut/tests/test_trading_api.py -k "revenue_repair or route_evidence"`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Deploy validation:

- Argo `torghut`, `jangar`, and `agents` are synced and not degraded for the promoted revision.
- Torghut `/trading/revenue-repair` includes `repair_bid_settlement_ledger`.
- `raw_repair_bid_count` may remain high, but selected dispatchable lots are bounded to the configured limit.
- `routeable_candidate_count` remains `0` while any selected lot is unsettled.
- `max_notional=0` until capital gate, promotion custody, TCA, empirical replay, rollout image proof, and Jangar
  dispatch custody all allow a paper or live stage.
- `zero_notional_or_stale_evidence_rate` must decrease only when output receipts retire their target reason codes.

## Rollout And Rollback

Roll out shadow-first:

- Emit settlement ledgers without denying existing repair schedules.
- Compare predicted compact lots against actual repair launches for one market session.
- Enable Jangar admission on compact lot ids only after duplicate raw-bid dispatch is visible and understood.
- Keep all selected lots zero-notional.

Rollback:

- Disable settlement consumption and fall back to the existing route evidence clearinghouse packet.
- Keep live submission disabled and capital at `max_notional=0`.
- Block Jangar normal dispatch if settlement ledgers are stale or malformed.
- Preserve raw clearinghouse evidence for audit while turning off compact-lot dispatch.

## Risks

- A settlement layer can hide important raw details if dashboards stop linking back to the clearinghouse packet.
- Dedupe state can hold a useful repair if a prior run hangs; TTL and active-run expiry must be explicit.
- The first implementation will make dispatch more selective before it increases routeability.
- ClickHouse direct auth failed from this workspace, so deployer validation should continue to use the guardrails
  exporter or a corrected least-privilege ClickHouse read credential.

## Handoff

The next implementation improves `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, and
`capital_gate_safety` before it can improve `routeable_candidate_count`. The smallest blocker preventing revenue impact
is not lack of evidence. It is unsettled evidence: the runtime now emits many repair bids, but those bids are not yet
compacted into bounded, deduped, receipt-producing zero-notional work.
