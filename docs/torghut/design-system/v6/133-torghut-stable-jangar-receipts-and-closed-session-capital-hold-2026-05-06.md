# 133. Torghut Stable Jangar Receipts And Closed-Session Capital Hold (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: Jangar has route/API integration and many control-plane modules; historical Swarm prose is not a one-to-one runtime spec.
- Matched implementation area: Jangar/control-plane integration.
- Current source evidence:
  - `services/jangar/src/routes/ready.tsx`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
  - `services/jangar/src/server/control-plane-source-serving-contract-verdict.ts`
  - `services/jangar/src/routes/api/torghut/trading/control-plane/quant/snapshot.ts`
  - `argocd/applications/agents/kustomization.yaml`
- Design drift note: Verify against current Jangar modules/routes before treating design contracts as live behavior.


## Decision

I am selecting **stable Jangar receipt consumption with a closed-session capital hold** as Torghut's next profitability
contract.

At `2026-05-06T20:08Z` to `2026-05-06T20:14Z`, Torghut was operational but not capital-ready. Live revision
`torghut-00243` and sim revision `torghut-sim-00344` became ready after startup probe warm-up, `/healthz` returned
`status=ok` for both live and sim, Postgres schema was current at Alembic head
`0029_whitepaper_embedding_dimension_4096`, and ClickHouse guardrails reported both replicas reachable with TA
signals and microbars current to `2026-05-06T20:11:37Z`. Empirical jobs were fresh and promotion-authority eligible
for `chip-paper-microbar-composite@execution-proof`.

The capital facts still say hold. Torghut autonomy was disabled. The direct autonomy route after the U.S. cash session
closed reported `market_session_open=false`, `last_state=expected_market_closed_staleness`, `last_ingest_signal_count=0`,
and no alert. Jangar's Torghut empirical reducer still classified forecast authority as `degraded` with
`registry_empty`; material action verdicts held `paper_canary`, held `live_micro_canary`, and blocked `live_scale`.
Jangar also exposed a heartbeat-authority instability where route-level controller heartbeats and direct heartbeat
storage could disagree within the same minute.

Torghut should not convert operational health into paper or live notional under those conditions. The selected design
requires Torghut to consume a stable Jangar heartbeat/material receipt, classify expected closed-session staleness as
observe-only, and keep paper/live capital at zero until forecast authority, market-session, profit inventory, and
Jangar stability receipts all agree.

The tradeoff is slower paper reentry after a healthy deployment. I accept that. Profitability comes from spending
capital only when the evidence is current, scoped, and stable, not from treating a green route as a trading signal.

## Runtime Objective And Success Metrics

This contract increases Torghut profitability by preventing false paper/live restarts while preserving zero-notional
learning and repair work.

Success means:

- Torghut consumes a stable Jangar receipt before acting on Jangar controller/runtime or material verdict state.
- Expected market-closed staleness allows observe and replay, but blocks new paper/live capital.
- Forecast `registry_empty` or missing forecast payloads remain explicit capital blockers.
- Fresh empirical jobs can fund zero-notional proof work without overriding forecast or market-session holds.
- Paper canary requires stable Jangar receipt, open or explicitly replayed market window, forecast tournament output,
  active profit inventory, scoped quant health, and rollback target.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, trading flags, broker
state, GitOps manifests, or ClickHouse tables.

### Cluster And Runtime Evidence

- Torghut namespace phase count was `Running=29` and `Completed=6`.
- Live `torghut-00243-deployment-dd8ff7496-h9r9n` and sim `torghut-sim-00344-deployment-68787fcc66-rmdp5` were created
  during the sample and became ready.
- Argo CD showed `torghut` Synced but Progressing while the new live and sim revisions settled.
- Recent Torghut events showed database migrations completing, new revisions becoming ready, and transient startup and
  readiness probe failures during warm-up.
- ClickHouse PDB warnings reported that both ClickHouse pods match multiple PodDisruptionBudgets. This is not a capital
  blocker by itself, but it is a deployer rollout risk to track.
- The agents service account cannot use pod exec in `torghut`, so deployer validation must use routes, Kubernetes
  list/get, exporter metrics, and database projections.

### Route And Control-Plane Evidence

- Live `/healthz` and sim `/healthz` returned `status=ok`.
- Torghut autonomy reported `enabled=false`, `market_session_open=false`, `last_state=expected_market_closed_staleness`,
  `last_reason=cursor_tail_stable`, `last_actionable=false`, `alert_active=false`, and `last_ingest_signal_count=0`.
- Empirical jobs were `status=healthy`, `authority=empirical`, with eligible jobs `benchmark_parity`,
  `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Jangar reported forecast authority `status=degraded`, `message=registry_empty`, and no eligible models.
- Jangar material action verdicts allowed `torghut_observe`, held `paper_canary`, held `live_micro_canary`, and blocked
  `live_scale`.
- Jangar heartbeat authority was unstable enough to require a stable receipt: route status selected
  `agents-controllers-b8b789d4f-2lqtl` while direct storage could show the serving deployment as the latest
  controller-role writer.

### Database And Data Evidence

- Torghut SQL connected as `torghut_app` to database `torghut`.
- Public schema had `69` tables and Alembic head `0029_whitepaper_embedding_dimension_4096`.
- `position_snapshots` had `42139` rows with latest `2026-05-06T20:13:06.742Z`.
- `trade_decisions` had `147623` rows with latest `2026-05-06T17:44:19.618Z`.
- `executions` had `13778` rows, but latest execution update was `2026-04-03T05:32:36.212Z`.
- `vnext_empirical_job_runs` had `20` rows with latest `2026-05-06T16:27:32.941Z`.
- `strategy_hypotheses`, `simulation_runtime_context`, and `simulation_run_progress` each had `0` rows.
- Decision status was dominated by `rejected=69909` and `blocked=63569`; latest `filled` decision was from
  `2026-04-02T19:29:13.609Z`.
- ClickHouse guardrail exporter reported both replicas up and TA freshness at `2026-05-06T20:11:37Z`.

### Source Evidence

- `services/torghut/app/trading/submission_council.py` already combines dependency quorum, empirical readiness, Jangar
  quant health, policy, and capital stage.
- `services/torghut/app/trading/hypotheses.py` exposes source-defined hypothesis state, but the durable
  `strategy_hypotheses` table is empty.
- `services/torghut/app/trading/empirical_jobs.py` already validates empirical proof truthfulness, freshness, lineage,
  and promotion authority.
- `services/torghut/app/trading/scheduler/simple_pipeline.py` has recently been hardened to gate simple live submits,
  but capital admission still needs a stable external receipt before paper/live widening.
- Existing tests cover submission council and empirical jobs. Missing tests are receipt-stability consumption and
  expected closed-session staleness handling for paper/live holds.

## Problem

Torghut has fresh infrastructure evidence and fresh empirical proof, but not a stable capital-admission product.

The current gaps are:

1. **Jangar receipt instability.** Torghut cannot treat raw Jangar heartbeat or material verdict samples as capital
   evidence until Jangar produces a stable receipt.
2. **Closed-session ambiguity.** Expected market-closed staleness is healthy for monitoring, but it is not an open
   window for new capital.
3. **Forecast authority missing.** `registry_empty` and missing forecast payloads mean paper and live forecast capital
   remain blocked.
4. **Empty durable profit inventory.** Runtime/source hypotheses exist elsewhere, but the durable hypothesis and
   simulation runtime tables are empty.
5. **Stale execution settlement.** Execution rows exist, but recent execution settlement is absent.

## Alternatives Considered

### Option A: Resume Paper After Route Health And Fresh TA

Pros:

- Fastest path to fresh paper data.
- Uses current live and sim deployments.
- Takes advantage of fresh TA and empirical jobs.

Cons:

- Ignores missing forecast authority.
- Ignores closed-session no-signal state.
- Ignores Jangar heartbeat instability.
- Spends paper capital without durable profit inventory or recent execution settlement.

Decision: reject.

### Option B: Freeze All Torghut Work Until Forecast Registry Is Eligible

Pros:

- Strong capital safety.
- Simple rule for operators.
- Avoids stale route and closed-session confusion.

Cons:

- Blocks zero-notional repair and replay.
- Wastes fresh empirical proof.
- Does not help Torghut learn which forecast or inventory work should be prioritized.

Decision: reject.

### Option C: Stable Jangar Receipt Consumption With Closed-Session Capital Hold

Pros:

- Preserves observe/replay throughput at zero notional.
- Makes closed-session staleness a first-class capital hold rather than a generic degradation.
- Requires stable Jangar authority before acting on controller/runtime or material verdict facts.
- Keeps forecast and profit inventory blockers explicit.
- Gives deployers a testable route from healthy rollout to paper readiness without privileged pod exec.

Cons:

- Requires Torghut to consume one more Jangar product.
- Requires market-session aware fixtures.
- Delays paper reentry until stable receipts and forecast proof exist.

Decision: select Option C.

## Architecture

Torghut consumes a Jangar stability receipt before capital admission.

```text
jangar_stability_receipt_consumer
  consumer_id
  generated_at
  account_label
  jangar_receipt_id
  receipt_action_class
  receipt_decision
  receipt_fresh_until
  receipt_stability_decision
  consumed_at
  echo_status
  reason_codes
```

Torghut emits a session capital context:

```text
session_capital_context
  context_id
  generated_at
  account_label
  market_session_state      # open, expected_closed, unexpected_stale, replay_window
  signal_continuity_ref
  forecast_authority_state  # empty, degraded, probation, eligible, stale
  empirical_job_refs
  profit_inventory_ref
  latest_execution_settlement_ref
  decision                  # observe_only, replay_only, repair_only, paper_hold, paper_allowed, live_hold, block
  max_notional
  rollback_target
```

Capital rules:

- `observe_only`: allowed with healthy service, stable or missing Jangar receipt, and zero notional.
- `replay_only`: allowed during expected closed-session staleness when a declared replay window and data snapshot exist.
- `repair_only`: allowed when the repair target is a named evidence gap and max notional is zero.
- `paper_allowed`: requires stable Jangar receipt, forecast probation or eligible model, active profit inventory,
  scoped quant health, fresh empirical proof, and an open or declared replay window.
- `live_micro_allowed`: requires all paper evidence plus recent execution settlement, TCA, reject-rate, drawdown, live
  submission enabled, and deployer approval.
- `live_scale`: requires live micro settlement and explicit rollback proof.

## Measurable Trading Hypotheses

H-SJR-01, stable receipt consumption reduces false paper starts:

- Hypothesis: requiring a stable Jangar receipt before paper prevents paper runs during heartbeat instability without
  reducing zero-notional repair throughput.
- Measurement: unstable receipt count, paper admission count, repair admission count, and rejected paper-start attempts.
- Guardrail: max notional remains zero when receipt stability is missing or unstable.

H-SJR-02, closed-session replay improves candidate quality without capital risk:

- Hypothesis: replay-only work during expected closed-session staleness improves forecast and strategy candidates
  without creating live or paper exposure.
- Measurement: replay candidates produced, forecast tournament pass rate, post-cost holdout performance, and next-session
  paper readiness.
- Guardrail: no paper/live orders from closed-session context.

H-SJR-03, active profit inventory should reduce blocked decisions:

- Hypothesis: requiring durable profit inventory before paper reduces blocked decision share from the current
  `63569` blocked decisions.
- Measurement: blocked decision ratio, profit inventory freshness, paper canary pass rate, and execution settlement age.
- Guardrail: source-only hypotheses can observe but cannot spend capital.

## Validation Gates

Engineer stage must add:

- Torghut reducer tests for stable, unstable, expired, and missing Jangar receipts.
- Market-session tests where `expected_market_closed_staleness` allows replay/observe but blocks paper/live.
- Forecast authority tests where `registry_empty` and missing forecast payloads are both capital holds.
- Submission council fixtures that keep empirical jobs useful for repair while preserving zero notional.
- API payload tests that echo the consumed Jangar receipt id and reason codes.

Deployer stage must prove:

- Torghut live and sim routes are healthy after rollout.
- Jangar stability receipt is current before any paper readiness claim.
- Closed-session status produces `observe_only` or `replay_only`, not paper/live admission.
- Forecast registry and profit inventory blockers are still visible after the new receipt consumer lands.
- Rollback disables receipt consumption and returns to existing shadow/simple gate behavior with paper/live held.

## Rollout Plan

1. Add a shadow Torghut consumer for Jangar stability receipts.
2. Emit session capital context in status and submission council diagnostics with max notional always zero.
3. Teach paper readiness to require stable Jangar receipt and open/replay market context.
4. Add forecast tournament and profit inventory references to the same context.
5. Move paper canary from hold to allowed only after two stable sessions and deployer validation.

## Rollback Plan

- Disable the Jangar receipt consumer feature flag.
- Keep existing empirical jobs, signal continuity, and simple submission gates.
- Preserve emitted session capital contexts for audit.
- Keep paper/live capital blocked if forecast authority or profit inventory is still missing.

## Risks

- Too-strict receipt consumption can slow paper recovery after a healthy rollout.
- Too-loose closed-session replay can produce misleading candidates if the replay window is not declared.
- Receipt payloads can become another status page unless they carry decision, expiry, notional, and rollback fields.
- Empirical jobs can look fresh while forecast authority is still empty; the capital reducer must keep those facts
  separate.

## Handoff Contract

Engineer acceptance:

- Torghut consumes and echoes Jangar stability receipts in shadow.
- Closed-session expected staleness cannot admit paper or live capital.
- Forecast missing, profit inventory empty, and stale execution settlement stay as separate reason codes.

Deployer acceptance:

- Read-only validation captures Torghut route health, signal continuity, empirical jobs, Jangar stability receipt,
  database inventory counts, and forecast authority.
- Paper canary remains held until stable Jangar receipt, open/replay market context, forecast proof, profit inventory,
  scoped quant health, and rollback target are all current.
- Rollback is a feature flag with no database mutation.
