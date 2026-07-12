# 188. Torghut Profit Freshness Frontier And Zero-Notional Repair Market (2026-05-12)

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

I am selecting a **Profit Freshness Frontier with a Zero-Notional Repair Market** for the next Torghut profitability
architecture step.

The current trading service is alive, but it is not profit-ready. `/trading/status` reports the live loop running on
revision `torghut-00320`, but live submission is blocked by `hypothesis_not_promotion_eligible`,
`empirical_jobs_not_ready`, and `simple_submit_disabled`. Signal lag is about `328k` seconds, market context is stale
by about `330k` seconds, all major market-context domains are stale, empirical jobs are stale, and no hypotheses are
promotion-eligible. Argo reports `torghut=Synced/Degraded` and `torghut-options=Synced/Progressing` while multiple
Torghut pods are in `ImagePullBackOff`.

The right move is not to force a paper canary. It is to rank zero-notional repairs by expected profit unlock and proof
freshness, then only graduate the repairs that close the data chain. This gives Torghut a way to innovate on profitable
hypotheses while the control plane is conservative: every repair is an experiment, every experiment has a measurable
before/after receipt, and every capital decision waits for Jangar reliability settlement.

The tradeoff is slower visible trading. I accept that because visible trading with stale signal, stale market context,
stale empirical proof, and degraded rollout would only create noise. Profitability comes from closing the freshness
frontier, not from submitting paper orders while the evidence plane is stale.

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-12. I did not mutate Kubernetes resources, database
records, GitOps resources, AgentRuns, broker state, Torghut flags, or ClickHouse data.

### Runtime And Cluster Evidence

- Argo reported `torghut=Synced/Degraded` and `torghut-options=Synced/Progressing` at Git revision
  `c11a2f48b8e1c18a5456311e9a3134d8dfc0ad0d`.
- Torghut live and simulation Knative deployments were available, but other supporting pods were not:
  `torghut-ws`, `torghut-ws-options`, `torghut-ta-sim`, and `torghut-options-ta` were in `ImagePullBackOff`.
- `torghut-ws` was waiting on image
  `registry.ide-newton.ts.net/lab/torghut-ws@sha256:67f4c169ac4bc80e2649902eda8763ad3545a675d11ec0d134820d009704566b`
  with repeated backoff events over about 9 hours.
- ClickHouse, Keeper, Torghut Postgres, guardrail exporters, options catalog, options enricher, the main Torghut
  revision, and `torghut-ta` task managers were running.
- Direct CNPG and ClickHouse operator inspection was blocked by RBAC for `agents-sa`, so the available database and data
  evidence is the typed Torghut and Jangar route surface.

### Data And Profitability Evidence

- `/trading/status` reported `enabled=true`, `running=true`, `mode=live`, `autonomy_enabled=false`, and active revision
  `torghut-00320`.
- Live submission was not allowed. Blocking reasons were `hypothesis_not_promotion_eligible`,
  `empirical_jobs_not_ready`, and `simple_submit_disabled`.
- Quant evidence was degraded. Latest metrics were current in the hot path, but stage evidence showed ingestion lag up
  to about `956k` seconds, with some materialization rows also failing.
- Market context was stale. The latest observed symbol was `AMZN`, last `as_of` was `2026-05-08T20:22:17Z`, freshness
  was about `330k` seconds, and `technicals`, `fundamentals`, `news`, and `regime` were all stale.
- Empirical jobs were stale: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.
- Hypothesis readiness found three hypotheses: two in `shadow`, one `blocked`, zero promotion eligible, and two
  rollback-required. Reason totals included `signal_lag_exceeded=3`, `tca_evidence_stale=2`,
  `market_context_stale=1`, `feature_rows_missing=1`, `drift_checks_missing=1`, and
  `required_feature_set_unavailable=1`.
- The active capital stage remained `shadow`, capital multipliers were all `0`, and Jangar material-action verdicts
  held `paper_canary` while blocking `live_micro_canary` and `live_scale`.

### Source Evidence

- `services/torghut/app/trading/proof_floor.py`, `profit_repair_settlement.py`, `route_reacquisition.py`,
  `executable_alpha_receipts.py`, `evidence_epochs.py`, `evidence_receipts.py`, and `hypotheses.py` already provide most
  of the local primitives needed for a profit freshness frontier.
- `services/torghut/app/trading/market_context.py`, `features.py`, `tca.py`, `empirical_jobs.py`, and
  `jangar_continuity.py` own the stale evidence dimensions that must be repaired before capital can widen.
- Jangar already consumes Torghut evidence through `/trading/consumer-evidence` and material-action verdicts. The new
  work should improve the shape of Torghut receipts and let Jangar reliability settlement decide when they can be used.
- Existing tests cover proof floor, route reacquisition, quant health, trading status, market context, TCA, and
  empirical lanes. The missing regression surface is repair-lot ranking under stale proof where one stale positive
  signal must not become a paper candidate.

## Problem

Torghut can list blockers, but it does not yet price the next repair by expected profit unlock. That causes three bad
operator choices:

1. Refresh everything, spending compute without knowing which hypothesis can become routeable.
2. Promote the best-looking partial positive, ignoring stale or missing proof dimensions.
3. Wait for all surfaces to recover, losing time when one bounded zero-notional repair could close the highest-value
   gap.

The system needs a frontier: a ranked set of repair lots that show what is stale, what profit hypothesis it blocks, what
zero-notional action will be taken, how success is measured, and which Jangar reliability settlement state is required
before the result can become paper-eligible.

## Alternatives Considered

### Option A: Promote The Least Bad Shadow Hypothesis

Use the current shadow hypotheses and route the least bad one into paper rehearsal.

Advantages:

- Fastest way to produce paper execution telemetry.
- Exercises downstream order and reconciliation paths.
- Easy to explain as "test what is already closest".

Disadvantages:

- Signal lag, market context, empirical proof, and TCA evidence are stale.
- Zero promotion-eligible hypotheses means the paper canary would override the readiness compiler.
- Jangar currently holds paper and blocks live action classes.

Decision: reject. The evidence says these are repair targets, not paper candidates.

### Option B: Broad Freshness Sweep

Refresh market context, empirical jobs, quant ingestion, TCA, feature rows, and drift checks in one wave.

Advantages:

- Directly attacks the visible stale surfaces.
- Likely improves operator confidence.
- Does not require a new reducer before repair starts.

Disadvantages:

- It does not rank repairs by expected profit unlock.
- It can spend effort on surfaces that still cannot pass Jangar reliability settlement.
- It does not create before/after receipts for hypothesis-level learning.

Decision: use as an execution tactic only when selected by the repair market.

### Option C: Profit Freshness Frontier And Zero-Notional Repair Market

Rank repair lots by expected post-cost daily net PnL unlock, evidence freshness, routeability, guardrail cost, and
Jangar reliability settlement. Execute only zero-notional repairs until proof closes.

Advantages:

- Converts stale proof into measurable repair hypotheses.
- Preserves capital safety while still innovating.
- Lets AAPL route repair, NVDA sim proof refill, market-context refresh, empirical rerun, and signal-ingestion repair
  compete on value.
- Gives Jangar a compact downstream receipt to consume.
- Makes rollback mechanical: stale, contradicted, or unprofitable repairs keep capital at zero.

Disadvantages:

- Adds a scoring layer that must be transparent and testable.
- Requires durable before/after refs and TTL discipline.
- Paper canary remains delayed until repair lots close.

Decision: select Option C.

## Architecture

Torghut emits one `profit_freshness_frontier` per account, mode, proof window, and active revision.

```text
profit_freshness_frontier
  schema_version
  frontier_id
  account_label
  trading_mode
  proof_window
  torghut_revision
  jangar_reliability_settlement_ref
  generated_at
  fresh_until
  freshness_dimensions
  repair_lots
  selected_zero_notional_repairs
  capital_posture
  rollback_target
```

Each freshness dimension records `dimension`, `state`, `observed_at`, `fresh_until`, `staleness_seconds`,
`blocking_hypotheses`, `reason_codes`, and `evidence_refs`. Required dimensions are signal ingestion, market context,
empirical proof, feature coverage, drift checks, TCA/fill quality, route readiness, schema/migration state, and Jangar
settlement.

Each repair lot records:

```text
repair_lot
  lot_id
  hypothesis_id
  candidate_id
  symbol_set
  blocked_dimension
  before_refs
  zero_notional_action
  expected_profit_unlock_bps
  expected_daily_net_pnl_unlock
  repair_cost_class
  validation_window
  success_criteria
  guardrail_failures
  after_refs
  state
```

The ranking function is intentionally simple at first:

```text
repair_priority =
  expected_daily_net_pnl_unlock
  * freshness_confidence
  * routeability_confidence
  * jangar_settlement_confidence
  - repair_cost_penalty
```

No repair lot can authorize paper or live capital. A closed repair lot may only graduate to `paper_replay_candidate`
when all required freshness dimensions are current, Jangar settlement allows `paper_canary`, empirical jobs are fresh,
TCA/fill quality passes, and the readiness compiler marks the hypothesis promotion-eligible.

## Implementation Scope

Engineer milestone 1: implement a read-only frontier builder in `services/torghut/app/trading/` that composes existing
market context, empirical job, quant health, TCA, feature, drift, hypothesis, and Jangar continuity evidence into repair
lots. Add tests for stale market context, stale empirical jobs, large signal lag, missing feature rows, and degraded
Jangar settlement.

Implementation note: repair lots should prefer `expected_daily_net_pnl_unlock` or equivalent post-cost daily net PnL
fields from upstream quality-adjusted profit packets when those estimates are available, and cite the source packet refs
on the lot. If no daily net unlock is available, the frontier may fall back to its transparent expected-bps proxy, but it
must keep every selected lot zero-notional until all freshness dimensions and Jangar settlement are current.

Engineer milestone 2: project the frontier from `/trading/status` and `/trading/consumer-evidence` without changing
capital behavior. Jangar should continue to see zero notional and repair-only posture until the frontier closes.

Engineer milestone 3: add one zero-notional repair executor path that can run a selected refresh or replay action and
write before/after receipt refs. The first allowed actions should be empirical proof renewal, market-context refresh,
and route/TCA recompute. Do not enable order submission from this path.

Deployer milestone: after merge, prove Torghut Argo health, workload readiness, `/trading/status`, Jangar consumer
evidence, and Jangar reliability settlement. If Torghut remains degraded because of image-pull faults, record the exact
image digest and keep the frontier in observe/repair-only.

## Validation Gates

- `failed_agentrun_rate`: Torghut repair lots that require AgentRuns must cite the Jangar reliability settlement stage
  admission before launching.
- `pr_to_rollout_latency`: any runtime code PR must have a Jangar rollout SLO receipt before the frontier can be called
  deployed.
- `ready_status_truth`: `ready` for profit action requires fresh signal, market context, empirical proof, TCA, schema,
  route, and Jangar settlement. A running service with stale data is not profit-ready.
- `manual_intervention_count`: the frontier must name one selected zero-notional repair, not a broad "refresh all"
  instruction.
- `handoff_evidence_quality`: every repair lot must carry before refs, after refs, command exit codes, tests, rollout
  refs, risk, rollback, and exact next action.

## Rollout And Rollback

Roll out in observe mode first. The frontier appears in route payloads and metrics, but all capital behavior remains
unchanged.

Enable zero-notional repair execution only after the observe payload is stable for one rollout. The initial executor
allowlist is empirical proof renewal, market-context refresh, and TCA recompute. Signal-ingestion repair can be added
only after the image-pull faults are cleared and Jangar settlement allows bounded repair.

Rollback is config-only: disable frontier projection or disable repair execution. The proof floor remains the hard
capital gate. If the frontier is wrong, capital stays zero because paper/live eligibility still depends on existing
readiness and Jangar material-action verdicts.

## Risks

- A simple ranking function can overvalue a noisy profit estimate. Mitigation: expose inputs and require held-out
  before/after receipts before promotion.
- Repair execution can mask a source outage by refreshing downstream projections. Mitigation: source freshness and
  route readiness are separate dimensions; stale upstream source keeps capital zero.
- Jangar settlement can be unavailable during an otherwise useful Torghut repair. Mitigation: observe-only remains
  allowed; repair execution waits for a bounded Jangar repair admission.
- Image-pull faults can block rollout validation. Mitigation: record digest-level blockers and keep the frontier
  repair-only until Argo and pods are healthy.

## Handoff

Implementation PR `codex/swarm-torghut-quant` covers engineer milestones 1 and 2 in observe mode:

- `services/torghut/app/trading/profit_freshness_frontier.py` builds the read-only frontier from existing Torghut proof,
  routeability, market-context, empirical, quant, hypothesis, and Jangar settlement refs.
- `/readyz`, `/trading/health`, `/trading/status`, and `/trading/consumer-evidence` project
  `torghut.profit-freshness-frontier.v1` without changing order submission, paper notional, live notional, or proof-floor
  authority.
- Jangar consumer evidence parses the frontier id, state, selected repair ids, and blocker refs into negative evidence
  for paper/live action budgets.

Implementation PR `codex/swarm-torghut-quant` also starts engineer milestone 3 with
`/trading/profit-freshness/zero-notional-repair`. The route returns
`torghut.zero-notional-repair-execution-receipt.v1` for the selected frontier lot, keeps `paper_notional_limit=0`,
`live_notional_limit=0`, and `order_submission_enabled=false`, and only runs the bounded local route/TCA recompute
runner when explicitly called with `execute=true`. Empirical proof renewal and market-context refresh are represented
as allowlisted, Jangar-admission-required receipts until their external runners are wired.

Next engineer action: wire the empirical proof renewal or market-context refresh runner behind the same receipt
contract after Jangar repair admission is available. Use the observed blockers as fixtures: signal lag around `328k`
seconds, market-context freshness around `330k` seconds, stale empirical jobs, zero promotion-eligible hypotheses,
degraded quant ingestion stages, `ImagePullBackOff` support pods, and Jangar paper/live action holds.

Next deployer action: after the implementation PR merges, verify Argo, workload readiness, `/trading/status`,
`/trading/consumer-evidence`, Jangar reliability settlement, and zero-notional capital posture. Do not call the rollout
healthy if the frontier is present but Torghut support pods remain in `ImagePullBackOff` or Jangar blocks paper/live
action classes.
