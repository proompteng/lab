# 189. Torghut Clock-Settled Repair Execution And Routeability Reentry (2026-05-12)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-12
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut quant routeability, evidence-clock settlement, repair execution, Jangar dispatch custody, active-session
TCA quality, empirical replay freshness, rollout proof, zero-notional capital safety, validation, rollout, rollback,
and cross-stage handoff.

Companion Jangar contract:

- `docs/agents/designs/185-jangar-clock-settled-repair-dispatch-and-rollout-custody-2026-05-12.md`

Extends:

- `188-torghut-evidence-clock-arbiter-and-routeable-profit-candidate-exchange-2026-05-12.md`
- `188-torghut-stage-clearance-consumer-and-repair-lot-broker-2026-05-12.md`
- `188-torghut-route-evidence-clearinghouse-and-execution-freshness-market-2026-05-12.md`
- `docs/agents/designs/184-jangar-rollout-custody-and-evidence-clock-dispatch-2026-05-12.md`

## Decision

I am selecting **clock-settled repair execution with routeability reentry gates** as the next Torghut architecture
step.

The current live system is safer than it is useful. Torghut `/healthz` returns HTTP 200, but `/readyz` returns HTTP 503. Live submission is held by `simple_submit_disabled`, `hypothesis_not_promotion_eligible`, and
`empirical_jobs_not_ready`. The live `evidence_clock_arbiter` reports `routeable_candidate_count=0`,
`zero_notional_or_stale_evidence_rate=0.9`, one current clock, and nine non-current clocks. Capital remains
`repair_only` with `max_notional=0`.

The important new evidence is a clock split, not just stale proof. ClickHouse `ta_signals` and `ta_microbars` are fresh
at `2026-05-12 18:48:40` for the active symbols, but the Torghut arbiter still marks `clickhouse_ta` as `missing`.
That means the runtime has a wiring or receipt gap between data availability and the capital-facing proof surface.
Postgres proof is stale in parallel: executions stop on `2026-04-02`, TCA stops on `2026-05-08`, expected-shortfall
rows are `0`, one positive metric window is stale from `2026-05-06`, and the only promotion decision is not allowed.

The decision is to turn the arbiter into an execution contract. Torghut will publish a `clock_settlement_receipt` and
`repair_execution_packets` that compare the direct data witnesses against the published evidence clocks. A repair can
run only when it names the split it retires, the value gate it is expected to move, the input and output receipts, and
the rollback target. A paper or live route cannot be minted from a fresh data surface while the corresponding capital
clock is missing, stale, split, or rollout-blocked.

The tradeoff is that the first implementation milestone is not a trading strategy. It is a proof-path repair: make
fresh TA, Jangar scoped quant, active-session TCA, empirical replay, rollout proof, and promotion custody settle in the
same object. I accept that because routeable post-cost profit evidence is impossible to trust until the clocks agree.

## Read-Only Evidence Snapshot

All assessment commands were read-only. I did not mutate Kubernetes resources, database rows, GitOps resources,
broker state, trading flags, or AgentRun objects.

### Cluster And Runtime

- The workspace is on `codex/swarm-torghut-quant-discover`, fast-forwarded to `origin/main` at `62a8f5f6d`.
- Kubernetes auth is `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` is unset, but
  in-cluster reads are authorized.
- Argo reports `torghut` `OutOfSync/Degraded` at revision `d617aea059ba043e9247b3fb8fd822adf5339ff3`.
- Argo reports `jangar` `Synced/Progressing` at `5bd6a131c17a4206a35ff12a70d61e17b013263d` and `agents`
  `Synced/Progressing` at `62a8f5f6d634da0478bc5d23aa0b0e6dca10bb2e`.
- Torghut core pods are running, including live and sim Knative revisions, Postgres, ClickHouse, Keeper, TA, TA sim,
  options TA, WebSocket, options catalog, options enricher, guardrail exporters, Alloy, and Symphony.
- Recent Torghut events still show rollout churn: options catalog/enricher restarts, readiness probe failures during
  rollout, duplicate ClickHouse PDB warnings, and `torghut-ws-options` readiness 503.
- Jangar recovered to HTTP 200 on `/ready`, but `execution_trust.status=degraded` because Jangar and Torghut implement
  and verify stages are stale.
- Agents has active work and retained failure debt: in the last six hours Jangar DB recorded `24` succeeded, `9`
  running, `7` pending, and `8` failed AgentRuns.

### Source

- `services/torghut/app/trading/evidence_clock_arbiter.py` is already the correct reducer boundary and is `1014`
  lines. It emits `evidence_clock_arbiter` and `routeable_profit_candidate_exchange`.
- `services/torghut/app/main.py` is `5664` lines and should remain an assembler. The next work should not add more
  scoring branches there.
- `submission_council.py` is `1318` lines and `tca.py` is `975` lines; they are high-risk contributors to readiness
  and execution quality.
- `profit_signal_quorum.py`, `routeability_repair_acceptance.py`, `profit_freshness_frontier.py`, and
  `evidence_clock_arbiter.py` already encode the right proof vocabulary.
- Existing tests cover evidence-clock invariants, routeability repair acceptance, profit-signal quorum, TCA refresh,
  trading readiness, consumer evidence, and profit windows.
- The missing invariant is direct-data to published-clock parity: fresh ClickHouse rows must not leave
  `clickhouse_ta` missing without emitting a `clock_wiring_split` repair packet.

### Database And Data

- Torghut Postgres schema head is `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- `trade_decisions` has `147695` rows across `19` symbols; newest `created_at` is
  `2026-05-12 17:54:23.892633+00`.
- `executions` has `13778` rows, `13555` filled rows, and newest `created_at=2026-04-02 20:59:45.104019+00`.
- `execution_tca_metrics` has `13775` rows across `12` symbols; newest `computed_at` is
  `2026-05-08 02:42:07.924691+00`, `expected_shortfall_rows=0`, and average absolute slippage is `13.7595` bps.
- Active-symbol TCA is stale and uneven: AAPL averages `9.2512` bps, AMD `14.9333`, AVGO `21.8583`, INTC `20.5711`,
  and NVDA `13.4759`; AMZN, GOOGL, and ORCL are absent from the TCA table under their active symbols.
- `strategy_hypotheses` has one active row. `strategy_hypothesis_metric_windows` has three rows, newest
  `window_ended_at=2026-05-06 18:01:00+00`, with one positive post-cost window that is now stale.
- `strategy_promotion_decisions` has one row and `allowed_count=0`.
- `vnext_empirical_job_runs` has `28` promotion-eligible rows, newest `created_at=2026-05-08 21:54:41.117502+00`,
  but runtime still classifies empirical jobs as not ready.
- `research_candidates`, `research_promotions`, and `vnext_promotion_decisions` are all empty.
- ClickHouse has current live data: `ta_signals=1040700` rows and `ta_microbars=1497470` rows, both newest at
  `2026-05-12 18:48:40`.
- Jangar has fresh latest metrics but expensive proof history: `quant_metrics_latest=4536` with newest
  `updated_at=2026-05-12 20:22:27.091955+00`; `quant_metrics_series` is estimated at `314034592` rows and `114 GB`;
  `quant_pipeline_health` is estimated at `51237248` rows and `17 GB`.
- Jangar latest-metric quality is weak: `3530` rows are `insufficient_data`, `878` are stale, and only `128` are good.

## Problem

Torghut now emits enough evidence to stay safe, but not enough settled evidence to become routeable.

The current failure modes are specific:

1. A direct data witness can be fresh while the capital-facing clock is missing.
2. Current trade decisions can hide stale executions and stale TCA.
3. Global Jangar latest metrics can be fresh while scoped quant health is degraded or unreachable.
4. A stale positive metric window can look profitable without current empirical replay or promotion approval.
5. Argo and rollout progress can be split from the runtime's source revision and image proof.
6. Jangar can launch repair work without knowing which Torghut clock split the run is meant to retire.

The architecture has to make the disagreement impossible to ignore. The next useful output is not another health
surface. It is a settlement receipt that says which clock is authoritative, which one is split, and which zero-notional
repair packet is allowed.

## Alternatives Considered

### Option A: Promote The Microstructure Candidate Toward Paper

Use the current ClickHouse TA feed, the one active hypothesis, and the positive stale metric window to start a paper
rehearsal for `H-MICRO-01`.

Advantages:

- Fastest apparent path to non-zero paper observations.
- Exercises execution and TCA code paths.
- Uses the one candidate with strategy lineage.

Disadvantages:

- Ignores stale TCA, stale empirical replay, and `allowed_count=0` promotion decisions.
- Converts a direct data witness into capital-adjacent readiness while the arbiter says the TA clock is missing.
- Violates `capital_gate_safety` and would lower trust in `routeable_candidate_count`.

Decision: reject. Fresh data is not settled proof.

### Option B: Freeze All Quant Work Until Argo And Readiness Are Green

Hold every Torghut quant action until Argo is healthy, Torghut `/readyz` is 200, and Jangar execution trust is no
longer degraded.

Advantages:

- Strong safety posture.
- Easy for deployer to enforce.
- Prevents accidental paper/live widening.

Disadvantages:

- Blocks the repair work needed to make readiness green.
- Treats clock-wiring repair and capital widening as the same risk.
- Does not explain which value gate a repair would improve.

Decision: reject as the normal posture. Keep it as the emergency brake if packet integrity fails.

### Option C: Clock-Settled Repair Execution

Publish a settlement receipt that compares direct data witnesses, evidence-clock payloads, Jangar custody, rollout
proof, TCA, empirical replay, and promotion custody. Allow only zero-notional repair packets until all clocks settle.

Advantages:

- Directly addresses the observed ClickHouse-fresh but arbiter-missing split.
- Preserves Torghut as the capital authority and Jangar as the dispatch authority.
- Gives engineer and deployer stages an ordered, testable implementation sequence.
- Maps every repair to the required value gates: `routeable_candidate_count`,
  `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, `capital_gate_safety`, and later
  `post_cost_daily_net_pnl`.
- Keeps options, route, and empirical repair useful without weakening capital safety.

Disadvantages:

- Adds one settlement receipt on top of existing proof surfaces.
- Requires tests across direct data witnesses and reducer payloads.
- Keeps routeable candidate count at zero until proof-path repairs land.

Decision: select Option C.

## Architecture

Torghut publishes `clock_settlement_receipt` beside the existing arbiter:

```text
clock_settlement_receipt
  schema_version = torghut.clock-settlement-receipt.v1
  receipt_id
  generated_at
  fresh_until
  account
  window
  torghut_revision
  source_commit
  evidence_clock_arbiter_ref
  routeable_profit_candidate_exchange_ref
  direct_data_witnesses[]
  published_clocks[]
  clock_splits[]
  settlement_state              # blocked | repair_ready | paper_rehearsal_ready | live_ready
  routeable_candidate_count
  zero_notional_or_stale_evidence_rate
  fill_tca_or_slippage_quality
  capital_decision
  selected_repair_packet_ids[]
  required_jangar_dispatch_ref
  rollback_target
```

Each direct witness is explicit:

```text
direct_data_witness
  witness_id
  witness_class                 # clickhouse_ta | postgres_tca | empirical | promotion | rollout | jangar_quant
  source_ref
  observed_at
  row_count
  freshness_state               # current | stale | missing | split
  matching_published_clock_name
  matching_published_clock_state
  split_reason_codes[]
```

Each repair packet is executable but zero-notional:

```text
repair_execution_packet
  packet_id
  target_clock
  target_value_gate
  repair_class
  expected_unblock_value
  required_input_receipts[]
  required_output_receipts[]
  max_runtime_seconds
  max_notional = 0
  forbidden_action_classes[]
  validation_commands[]
  rollback_target
```

Initial ordered packets:

1. `clock_wiring_split`: pass ClickHouse TA freshness into the arbiter and prove fresh rows no longer publish
   `clickhouse_ta_clock_missing`.
2. `jangar_quant_scoped_health`: require reachable scoped quant health for `PA3SX7FYNUTF/15m`; do not use global
   latest metrics as scoped proof.
3. `active_session_tca_refresh`: refresh or explicitly reject active-symbol TCA for AAPL, AMD, AMZN, AVGO, GOOGL,
   INTC, NVDA, and ORCL; add expected-shortfall samples before routeability can increase.
4. `empirical_replay_reclock`: rerun or retire stale empirical jobs and bind replay outputs to the active hypothesis.
5. `promotion_custody_recheck`: require a non-empty allowed promotion decision before paper rehearsal.
6. `rollout_image_proof`: require Torghut/Jangar rollout and image proof before deployer can claim operational
   readiness.

## Implementation Scope

Engineer milestone 1 is deliberately small and high leverage:

- Add a pure `clock_settlement` reducer next to `evidence_clock_arbiter.py`.
- Feed it with the current arbiter payload, direct ClickHouse freshness, TCA summary, empirical status, promotion
  counts, Jangar scoped quant health, and rollout status.
- Update `/readyz` and `/trading/status` to expose only a compact settlement summary plus packet ids.
- Add regression tests proving fresh ClickHouse rows cannot coexist with `clickhouse_ta_clock_missing` without a
  `clock_wiring_split` packet.
- Keep `main.py` integration thin and keep all scoring in pure modules.

Engineer milestone 2:

- Add active-session TCA and expected-shortfall repair packets.
- Add packet ids to Jangar dispatch inputs.
- Prove `routeable_candidate_count` remains `0` until TCA, empirical, promotion, quant, rollout, and capital clocks
  are all current.

## Validation Gates

Local validation for engineer PRs:

- `pytest services/torghut/tests/test_evidence_clock_arbiter.py`
- `pytest services/torghut/tests/test_routeability_repair_acceptance.py`
- `pytest services/torghut/tests/test_trading_api.py -k "evidence_clock or routeable_profit_candidate"`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Deploy validation:

- Argo `torghut`, `jangar`, and `agents` are synced and not degraded for the promoted revision.
- Torghut `/readyz` includes `clock_settlement_receipt`.
- `clock_wiring_split` is absent when ClickHouse direct witnesses and `clickhouse_ta` published clock agree.
- `routeable_candidate_count=0` while any required clock remains stale, missing, split, or blocked.
- `max_notional=0` until capital gate, promotion custody, and Jangar dispatch custody all allow paper or live.

## Rollout And Rollback

Roll out shadow-first. The settlement receipt is observational until engineer and verify stages prove parity with the
existing arbiter.

Rollback is simple:

- Disable settlement consumption and keep existing `evidence_clock_arbiter` behavior.
- Keep repair packets zero-notional.
- Revert to `repair_only`, `max_notional=0`, and `routeable_candidate_count=0`.
- If the reducer disagrees with direct data witnesses, Jangar must hold normal dispatch and launch only the
  `clock_wiring_split` repair packet.

## Risks

- The direct data witness path can become expensive if it scans proof-history tables. Keep it on latest/materialized
  paths and bounded ClickHouse summaries.
- A new receipt can create audit volume if repair packets are not deduplicated by clock and value gate.
- The clock settlement contract will reveal more negative evidence; dashboards may look worse before routeability
  improves.
- The memory helper returned HTTP 500 during assessment, so the final handoff should record that memory persistence was
  attempted and blocked by service connectivity.

## Handoff

The next implementation improves `zero_notional_or_stale_evidence_rate` first by retiring the ClickHouse TA
clock-wiring split. The first revenue-adjacent gate is `routeable_candidate_count`; it must remain zero until direct
data witnesses and published capital clocks agree. The smallest blocker preventing revenue impact is the unsettled
proof path: fresh ClickHouse data is not reaching the arbiter as a current `clickhouse_ta` clock, while TCA, empirical,
promotion, and rollout clocks are still stale or blocked.

## Implementation Note

The first implementation cut adds `services/torghut/app/trading/clock_settlement.py` as a pure observe-mode reducer and
surfaces `torghut.clock-settlement-receipt.v1` on `/readyz`, `/trading/status`, `/trading/health`, and
`/trading/consumer-evidence`. The reducer consumes the current `evidence_clock_arbiter`,
`routeable_profit_candidate_exchange`, direct ClickHouse TA freshness from the existing ingestor, Jangar scoped quant
health, TCA summary, empirical status, promotion quorum, and rollout image proof. It does not change live submission
defaults, routeability decisions, or notional caps.

The direct ClickHouse TA freshness witness is now also fed into the arbiter. If that witness is current and the
published `clickhouse_ta` clock is still missing or stale, the settlement receipt emits a zero-notional
`clock_wiring_split` repair packet with `paper_canary`, `live_micro_canary`, and `live_scale` listed as forbidden
action classes. When the direct witness and published clock agree, the packet is absent.

Validation for this cut covers the fresh-ClickHouse/missing-published-clock split, the settled no-packet path, API
payload presence, unchanged `max_notional=0`, Ruff formatting/checking, and Pyright. Rollback remains field-level:
remove or ignore `clock_settlement_receipt`, stop passing `clickhouse_ta_status` into the arbiter, and keep existing
proof-floor, live-submission, and zero-notional capital gates in force.
