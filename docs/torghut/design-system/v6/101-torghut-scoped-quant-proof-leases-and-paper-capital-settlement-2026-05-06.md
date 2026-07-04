# 101. Torghut Scoped Quant Proof Leases And Paper Capital Settlement (2026-05-06)

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

Torghut should implement **scoped quant proof leases and paper-capital settlement** before any paper or live capital
reentry.

The current system is safe, observable, and unprofitable. Live mode is configured, but the active capital stage is
`shadow`, simple submission is disabled, autonomy is disabled, zero hypotheses are promotion eligible, all three
hypotheses require rollback, and the newest decision in the status surface is from `2026-05-04T17:25:57Z`.
Postgres, ClickHouse, Alpaca, schema checks, and Jangar aggregate quant health are OK. The blockers are proof quality:
empirical jobs are stale from `2026-03-21`, signal lag is far beyond the hypothesis entry contracts, Jangar dependency
quorum blocks on stale empirical jobs, and Torghut has not configured the typed Jangar quant-health URL.

The next profitable step is not to enable live trading. It is to turn proof freshness into a tradable lease: each
hypothesis must cite account/window quant health, empirical authority, rejection attribution, and paper dry-run
settlement before capital can increase. A lease can make repair work measurable without pretending it is alpha.

The tradeoff is slower capital reentry. I accept that because every current trading indicator says the system is in a
proof repair phase, not a capital deployment phase.

## Read-Only Evidence Snapshot

All evidence for this design pass was read-only. No Kubernetes resources or database rows were mutated.

### Cluster Evidence

- Torghut live revision `torghut-00225` and sim revision `torghut-sim-00306` were both `2/2 Running`.
- Torghut database, ClickHouse replicas, keeper, TA jobs, WebSocket services, options catalog, and options enricher were
  running. The current `torghut-db-migrations` job was running during the sample.
- Recent Torghut events showed readiness probe failures during options catalog and enricher replacement, repeated
  ClickHouse multiple-PDB warnings, and no fresh empirical repair job beyond retention.
- Jangar and agents Deployments were healthy, and Jangar aggregate quant health was fresh.
- Direct database exec and privileged CRD listing were forbidden for the runtime identity. Torghut proof contracts must
  be validated through typed routes, stored rows, and artifact refs that the services already expose.

### Data Evidence

- `GET /healthz` returned HTTP 200 `{"status":"ok","service":"torghut"}`.
- `GET /db-check` returned HTTP 200 with `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing heads, no unexpected heads, and lineage-ready status. Known
  parent-fork warnings remain documented.
- `GET /trading/health` returned HTTP 503 `status=degraded`. Postgres, ClickHouse, and Alpaca were OK; empirical jobs
  were degraded; live submission was blocked by `simple_submit_disabled`; quant evidence was not required and not
  configured.
- `GET /trading/status` returned `mode=live`, `pipeline_mode=simple`, `execution_lane=simple`, `active_revision`
  `torghut-00225`, `capital_stage=shadow`, zero submitted orders in the current process, and `last_decision_at`
  `2026-05-04T17:25:57.901670Z`.
- The same status returned `signal_lag_seconds=15027`, `no_signal_reason_streak.cursor_tail_stable=672`,
  `promotion_eligible_total=0`, `rollback_required_total=3`, and dependency quorum `block` for
  `empirical_jobs_degraded`.
- Empirical jobs were `ready=false`, `status=degraded`, `authority=blocked`, with stale completed
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` jobs created
  `2026-03-21T09:03:22.150009+00:00`.
- TCA evidence exists but is old: `order_count=13775`, `avg_abs_slippage_bps=568.6138848199565249`, and
  `last_computed_at=2026-04-02T20:59:45Z`.
- Jangar quant health was fresh in aggregate, but Torghut reported `quant_health_not_configured`, so the submission
  council is not consuming the available proof.

### Source Evidence

- `services/torghut/app/trading/submission_council.py` already requires a typed quant-health endpoint path and blocks
  capital when quant health is required and not OK.
- `services/torghut/app/trading/empirical_jobs.py` already distinguishes missing, stale, truthful, and
  promotion-authority-eligible empirical artifacts.
- `services/torghut/app/trading/hypotheses.py` already compiles hypothesis state, capital stage, promotion eligibility,
  rollback requirement, feature dependencies, and Jangar dependency quorum.
- `services/torghut/app/main.py` already exposes `/trading/status`, `/trading/health`, `/trading/empirical-jobs`, and
  `/db-check`; it should not become the only repair authority. A compact proof settlement route should compose existing
  helpers.
- Tests already cover empirical jobs, hypothesis governance, submission council, quant evidence behavior, DB checks,
  trading API, runtime closure, and property/stateful trading helpers. Missing coverage is paper-capital settlement from
  scoped proof leases and rejection attribution.

## Problem

Torghut can explain why capital is blocked, but it cannot yet prove when capital should reenter.

The current blockers are not equal:

- stale empirical jobs make promotion authority unavailable;
- unconfigured scoped quant health prevents the submission council from consuming Jangar's fresh proof;
- signal lag breaks entry contracts for all current hypotheses;
- old TCA and zero recent executions make profitability claims weak;
- simple submission is disabled, which is appropriate while proof is unsettled.

If Torghut only refreshes stale jobs, it may still lack scoped account/window evidence. If it only wires quant health,
it may still lack empirical authority. If it enables simple submission first, it skips the proof that should price
capital.

## Alternatives Considered

### Option A: Refresh Empirical Jobs And Then Reassess

Run the four stale empirical jobs and keep all other gates unchanged.

Pros:

- Directly addresses the named dependency-quorum block.
- Uses existing empirical artifact contracts.
- Produces clear freshness evidence.

Cons:

- Does not wire Torghut to Jangar's typed quant-health route.
- Does not settle paper-capital dry runs.
- Does not address signal lag or stale TCA.

Decision: necessary repair, insufficient architecture.

### Option B: Enable Quant Health As Informational Only

Configure `TRADING_JANGAR_QUANT_HEALTH_URL` but keep quant evidence optional.

Pros:

- Low-risk rollout.
- Lets operators compare aggregate and scoped route behavior.
- Can be deployed before capital is considered.

Cons:

- Does not create a hard paper-capital gate.
- Can hide account/window emptiness behind aggregate health.
- Does not force rejected-decision and empirical proof to settle together.

Decision: use during shadow, reject as final gate.

### Option C: Scoped Quant Proof Leases And Paper Capital Settlement

Require scoped quant leases and paper-capital settlement receipts before capital increases.

Pros:

- Links every capital decision to account, strategy, and window proof.
- Keeps zero-notional repair active while capital remains blocked.
- Forces empirical freshness, quant health, signal lag, and rejection attribution into one settlement record.
- Gives Jangar a precise proof artifact to spend through action-class authority.
- Maintains a clear rollback to the existing conservative submission council.

Cons:

- Adds a settlement route and schema.
- Requires careful rollout so optional quant health does not silently become capital authority.
- Delays capital until paper proof is current and positive.

Decision: select Option C.

## Architecture

### TorghutScopedProofLease

Torghut consumes Jangar scoped proof and materializes its own lease view:

```text
torghut_scoped_proof_lease
  lease_id
  generated_at
  fresh_until
  account
  strategy_id
  hypothesis_id
  window
  jangar_quant_health_ref
  empirical_job_set_ref
  signal_continuity_ref
  rejection_attribution_ref
  tca_ref
  capital_stage
  decision
  reason_codes
```

The lease is a proof object, not an order instruction. It can support `observe`, `repair`, `paper_dry_run`, or
`paper_capital`. `live_capital` requires a separate paper-capital settlement history.

### PaperCapitalSettlement

Torghut records a settlement receipt when a lease is used for a paper-capital dry run:

```text
paper_capital_settlement
  settlement_id
  lease_id
  hypothesis_id
  account
  window
  session_date
  paper_orders_attempted
  paper_orders_filled
  realized_pnl_proxy
  avg_abs_slippage_bps
  max_drawdown_bps
  reject_rate
  decision
  rollback_trigger
```

Capital can increase only when settlements are fresh, non-empty, and within guardrails.

## Measurable Trading Hypotheses

- Wiring scoped quant health will eliminate `quant_health_not_configured` and produce non-empty account/window pipeline
  stages before any paper-capital decision.
- Empirical refresh will turn all four required jobs fresh and truthful against current dataset/runtime refs before
  promotion eligibility can become positive.
- Signal recovery will reduce signal lag below each hypothesis entry contract for two consecutive windows or retire the
  hypothesis from the capital candidate set.
- Rejection attribution will reduce unknown blocker count to zero and assign each current rejection to data, strategy,
  policy, market-context, or execution repair.
- Paper-capital settlement will produce nonzero paper orders and bounded slippage before live capital is considered.

## Capital Guardrails

Paper capital remains blocked unless all are true:

- Jangar scoped proof lease is fresh for the exact account, strategy, and window.
- Torghut consumes the typed quant-health URL and scoped pipeline stages are present.
- Required empirical jobs are fresh, truthful, and promotion-authority eligible.
- Signal lag and feature quality satisfy each hypothesis entry contract.
- Rejected decisions have typed attribution and no unresolved critical blocker.
- TCA and paper settlement evidence are fresh enough for the configured window.
- Kill switch is off and submission toggles are explicitly enabled for paper mode.

Live capital additionally requires:

- multiple accepted paper-capital settlements across the agreed session count;
- positive post-cost evidence after slippage and reject-rate guardrails;
- no open rollback trigger;
- explicit live submission enablement;
- a rollback plan that returns to shadow on the first failed guardrail.

## Engineer Acceptance Gates

- Add configuration and tests that require `TRADING_JANGAR_QUANT_HEALTH_URL` to target
  `/api/torghut/trading/control-plane/quant/health`.
- Add proof settlement tests for unconfigured, invalid, aggregate-only, degraded scoped, and healthy scoped quant
  leases.
- Add a compact route such as `GET /trading/control-plane/scoped-proof-leases` that composes existing empirical,
  hypothesis, signal, quant, rejection, and TCA evidence without mutating state.
- Add paper-capital settlement fixtures with zero orders, stale empirical jobs, high slippage, missing rejection
  attribution, and accepted settlement.
- Add regression tests proving `simple_submit_disabled` and kill switch state still block paper/live capital even when
  proof leases are fresh.

## Deployer Acceptance Gates

- Deploy the quant-health URL wiring in sim first with quant health informational.
- Promote to required scoped quant proof only after the sim route shows account/window stages and Torghut health no
  longer reports `quant_health_not_configured`.
- Run empirical refresh jobs and verify all four required jobs are fresh, truthful, and current.
- Enable paper dry run only after scoped proof leases are fresh and signal lag satisfies entry contracts or hypotheses
  are retired.
- Enable paper capital only after accepted dry-run settlements are present.
- Keep live capital blocked until paper settlement history and submission toggles satisfy the live policy.

## Rollout Plan

1. Shadow proof: configure the typed quant-health URL and publish scoped proof leases without changing capital behavior.
2. Required scoped proof in sim: make account/window quant proof required for sim paper dry runs.
3. Empirical refresh: refresh and validate the four required empirical jobs.
4. Paper dry run: produce settlement receipts with zero or bounded notional according to deployer policy.
5. Paper capital: allow constrained paper capital only after settlement passes.
6. Live review: require a separate deployer review before live capital can move from `block` to `allow`.

## Rollback Plan

- Set scoped proof enforcement back to informational.
- Expire all unsettled proof leases and paper-capital settlement receipts.
- Return all hypotheses to `shadow` or `blocked` according to their manifest state.
- Leave `TRADING_ENABLED` and `TRADING_MODE` unchanged, but keep live submission disabled.
- Preserve proof artifacts for audit and rerun the smallest failing acceptance gate before retry.

## Risks

- Fresh quant proof without fresh empirical proof can still be unprofitable.
- Fresh empirical proof from old datasets can look authoritative unless runtime and dataset refs are checked.
- Paper settlements can be gamed by tiny sample sizes. Minimum fills, windows, and slippage guardrails must be explicit.
- Current RBAC prevents direct database inspection. The settlement route must be deterministic and rich enough for
  review from typed service evidence.
