# 121. Torghut Opening Bell Proof Ladder And Account-Scoped Alpha Reentry (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: strategy/alpha/discovery/profile modules and tests exist, but research strategy proposals are not all promoted runtime strategies.
- Matched implementation area: Strategy, alpha, TSMOM, regime, portfolio, and sizing.
- Current source evidence:
  - `services/torghut/app/strategies/catalog.py`
  - `services/torghut/app/trading/alpha/tsmom.py`
  - `services/torghut/app/trading/strategy_runtime`
  - `services/torghut/app/trading/discovery/candidate_specs.py`
  - `services/torghut/app/trading/portfolio`
- Design drift note: A research/stress module is not enough to call a strategy live; promotion still depends on proof/readiness gates.


## Decision

I am selecting an **opening bell proof ladder with account-scoped alpha reentry** for Torghut.

The live service is operational but not capital-ready. At `2026-05-06T13:10Z`, Torghut `/healthz` returned `ok`, but
`/trading/health` returned HTTP `503` because `live_submission_gate.allowed=false` with reason
`simple_submit_disabled`. `/trading/status` showed `TRADING_MODE=live`, `active_revision=torghut-00237`,
`alpha_readiness_hypotheses_total=3`, zero promotion-eligible hypotheses, and three rollback-required hypotheses.
H-CONT and H-REV were in `shadow`; H-MICRO was `blocked`. Dependency quorum was `block` because empirical jobs are
degraded.

The data plane is split in a way that can mislead a team at the open. Torghut `/db-check` is clean enough to operate:
`ok=true`, `schema_current=true`, and a tolerated single migration branch. The ClickHouse guardrails exporter reports
current table-wide max event timestamps. But Jangar's AAPL latest signal is from `2026-05-04 20:19:07`, market-context
health for AAPL is degraded with stale domains, recent persisted decisions are rejected rows from `2026-05-04T17:25Z`,
and the live account quant latest-store path is stale by roughly `71036` seconds. The aggregate quant route is fresh;
the account proof is not.

The selected design makes Torghut treat the opening session as a proof ladder, not a capital switch. Before the market
opens, Torghut builds an account-scoped proof packet from Jangar's opening reconciliation epoch, empirical jobs,
account quant freshness, symbol freshness, market context, broker status, and hypothesis blockers. At the open, the
system can observe and run zero-notional repairs. Paper canary and live micro-canary require consecutive fresh account
proof packets and a Torghut activation receipt that cites the Jangar epoch.

The tradeoff is slower reentry after outages or stale overnight proof. I accept that because stale per-account data
and stale symbol context will erase the expected edge faster than a conservative opening ladder will. Profitability
comes from entering only when the edge proof is current, not from being first to submit an order.

## Evidence Snapshot

All checks were read-only. I did not change trading flags, Kubernetes resources, database rows, broker state, or
GitOps manifests.

### Cluster And Rollout Evidence

- Branch `codex/swarm-torghut-quant-discover` was clean and equal to `origin/main` before this document change.
- Runtime identity was `system:serviceaccount:agents:agents-sa`.
- Agents service and controllers were running; `deployment/agents=1/1` and `deployment/agents-controllers=2/2`.
- Agents events still showed recent readiness probe timeouts on the agents service and controller pods, so route
  readiness should remain part of the proof packet.
- Jangar `/health` returned `status=ok`; Jangar pods and DB were running.
- Torghut live `torghut-00237` and sim `torghut-sim-00326` were running. Torghut sim `/healthz` returned `ok` and
  `/trading/status` showed non-live mode allowed by `live_submission_gate.reason=non_live_mode`.
- Torghut ClickHouse replicas, Keeper, Postgres, live TA, sim TA, options catalog, options enricher, options TA,
  websocket, guardrail exporters, Alloy, and Symphony pods were running.
- Recent Torghut events showed sim rollout readiness succeeding after transient startup/readiness probe failures.
- The service account could not list Knative services or StatefulSets and could not exec into Torghut database pods.
  Direct DB proof therefore stays behind service-owned projections for this lane.

### Data, Schema, And Freshness Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, `schema_graph_branch_count=1`, and
  `schema_graph_branch_tolerance=1`.
- `/db-check` retained two lineage warnings for documented migration forks:
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `/trading/health` returned HTTP `503` with Postgres, ClickHouse, Alpaca, and universe checks ok, but
  `live_submission_gate.detail=simple_submit_disabled`.
- `/trading/status` showed `last_decision_at=2026-05-04T17:25:57.901670Z`, zero promotion eligible hypotheses, and
  rollback required for all three hypotheses.
- H-CONT blockers included `jangar_dependency_block` and `signal_lag_exceeded`.
- H-MICRO blockers included `drift_checks_missing`, `feature_rows_missing`, `required_feature_set_unavailable`,
  `jangar_dependency_block`, and `signal_lag_exceeded`.
- H-REV blockers included `jangar_dependency_block`, `market_context_stale`, and `signal_lag_exceeded`.
- `/trading/autonomy` reported four stale empirical jobs:
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- The empirical job artifacts were truthful and promotion-authority eligible when produced, but stale from
  `2026-03-21T09:03:22Z` on dataset `torghut-full-day-20260318-884bec35`.
- Jangar aggregate quant health for `window=1d` was fresh with `latestMetricsCount=540` and
  `metricsPipelineLagSeconds=5`, but account-scoped `PA3SX7FYNUTF` quant health was stale by about `71036` seconds.
- Jangar account-scoped quant alerts for `PA3SX7FYNUTF` returned `50` open alerts, including critical
  `metrics_pipeline_lag_seconds` alerts.
- Jangar `GET /api/torghut/ta/latest?symbol=AAPL` returned latest AAPL bars and signals from
  `2026-05-04 20:19:07`.
- Jangar market-context health for AAPL was degraded with stale technicals, fundamentals, news, and regime.
- ClickHouse guardrails exporter was scraping successfully and table-wide freshness was current, proving table-wide
  data health is not enough for symbol/hypothesis capital readiness.

### Source Evidence

- `services/torghut/app/main.py` builds `/trading/health`, `/trading/status`, `/trading/autonomy`, `/db-check`,
  decisions, executions, and metrics in one high-risk `4051` line module.
- `services/torghut/app/trading/submission_council.py` already consumes dependency quorum, empirical jobs, DSPy
  runtime, quant health, market context, toggle parity, and certificate evidence. It needs an opening proof packet,
  not another ad hoc blocker.
- `services/torghut/app/trading/empirical_jobs.py` validates freshness, truthfulness, lineage, candidate ids, and
  dataset snapshots; it is the right authority for stale empirical replay obligations.
- Hypothesis manifests under `services/torghut/config/trading/hypotheses/` already encode lane-specific gates and
  blockers: H-CONT needs fresh signal continuity, H-MICRO needs microstructure features and drift checks, and H-REV
  needs fresh market context.
- Tests exist for empirical jobs, submission gates, market context, hypotheses, trading API health, quant evidence, and
  scheduler safety. The missing system-level tests are opening proof ladder cases across aggregate quant, account
  quant, symbol freshness, market context, empirical freshness, and live submission toggles.

## Problem

Torghut has several truthful gates, but they are evaluated as independent status fragments during the most important
market phase.

At the open, a human or deployer can see:

1. the route is alive,
2. the database schema is current,
3. aggregate quant health is fresh,
4. account quant health is stale but still `status=ok` pre-open,
5. symbol latest proof is stale,
6. empirical jobs are stale,
7. hypotheses are rollback-required,
8. live submission is disabled.

Those facts should become one account-scoped proof ladder. Without that ladder, there are two failure modes. The team
can stay frozen even when zero-notional repair would improve profit option value, or it can overreact to aggregate
freshness and open capital before the account/hypothesis proof is current.

## Alternatives Considered

### Option A: Fix Live Submission And Quant URL Configuration First

Pros:

- Directly improves `/trading/health`.
- Easy to validate with one endpoint.
- Low implementation complexity.

Cons:

- Does not refresh empirical jobs.
- Does not fix account-scoped quant lag or stale symbol/latest proof.
- Can make the route look healthier before the alpha proof is ready.

Decision: reject as the architecture. Configuration repair is one ladder step, not the ladder.

### Option B: Keep Live Frozen Until All Proof Surfaces Are Fresh

Pros:

- Strongest capital safety posture.
- Simple deployer rule.
- Avoids edge-case interpretation at the open.

Cons:

- Prevents zero-notional repair and paper observation from clearing stale proof.
- Gives no ranking for which blocker most improves profitability.
- Treats pre-open proof collection the same as live order submission.

Decision: reject. We need safe repair motion, not just a freeze.

### Option C: Opening Bell Proof Ladder With Account-Scoped Alpha Reentry

Pros:

- Separates observe, repair, paper canary, live micro-canary, and live scale.
- Makes account-scoped freshness mandatory before capital.
- Lets stale empirical, market-context, and quant proof generate zero-notional repair work.
- Ranks repairs by hypothesis-specific profit unlock.
- Uses Jangar opening proof reconciliation as the cross-plane authority boundary.

Cons:

- Adds another receipt and test matrix.
- Requires careful market-session clocks.
- Can delay otherwise healthy routes from paper activation.

Decision: select Option C.

## Architecture

Torghut adds an opening proof packet and ladder:

```text
opening_bell_proof_packet
  packet_id
  generated_at
  expires_at
  market_session
  session_phase                  # pre_open, opening_collect, regular, closed
  account
  strategy_id
  hypothesis_id
  window
  jangar_opening_epoch_ref
  empirical_jobs_ref
  account_quant_ref
  symbol_freshness_ref
  market_context_ref
  broker_ref
  tca_ref
  hypothesis_readiness_ref
  live_submission_gate_ref
  proof_status                   # observe, repair_only, paper_candidate, live_candidate, blocked
  max_notional
  required_repairs
  profit_unlock_score
```

```text
opening_bell_proof_ladder
  ladder_id
  account
  market_session
  stages
    observe                      # route alive, DB current, max_notional=0
    repair_only                  # Jangar epoch names repairable proof gaps, max_notional=0
    paper_probe                  # sim/account proof fresh, empirical fresh, market context current
    paper_canary                 # repeated paper probe packets and no critical scoped alerts
    live_micro_canary            # paper closure plus live proof fresh and broker/TCA current
    live_scale                   # out of first implementation scope
```

Stage rules:

- `observe` requires Torghut route health and schema current.
- `repair_only` requires a Jangar opening epoch and one or more named proof gaps. Max notional is always `0`.
- `paper_probe` requires fresh empirical jobs, non-empty sim and account quant metrics, symbol freshness for the active
  universe, and no unresolved critical alert for the target account/window.
- `paper_canary` requires at least three consecutive fresh proof packets across the opening collection window and a
  clean paper closure receipt.
- `live_micro_canary` requires paper canary closure, live `/trading/health=200`, live submission enabled, configured
  typed quant health, broker reconciliation, TCA current, and explicit deployer approval.
- `live_scale` is out of scope until multiple live micro-canary sessions close with positive post-cost expectancy.

## Profit Hypotheses And Guardrails

- H-CONT hypothesis: fresh signal continuity plus account quant proof will improve continuation entries after the first
  opening collection window. Success means H-CONT clears `signal_lag_exceeded` and remains shadow/paper only until
  empirical replay is current.
- H-MICRO hypothesis: feature-row and drift repair has higher profit option value than live toggle changes. Success
  means H-MICRO moves from `blocked` to `shadow` only after microstructure features and drift checks are present.
- H-REV hypothesis: market-context repair is prerequisite for event reversion. Success means AAPL-style stale context
  cannot enter paper canary, and restored context lowers `market_context_stale` blockers.
- Cross-lane hypothesis: account-scoped quant freshness reduces false positive readiness. Success means aggregate-only
  quant proof never produces `paper_probe` or above.
- Guardrail: any proof packet with stale empirical jobs, stale account quant proof, stale symbol proof, unresolved
  critical alerts, or `simple_submit_disabled` has `max_notional=0`.

## Implementation Scope

Torghut engineer scope:

- Add a pure opening proof packet builder that consumes the Jangar opening epoch, empirical jobs, quant evidence,
  symbol/latest status, market context, broker status, TCA summary, hypothesis readiness, and live submission gate.
- Expose the packet in `/trading/status` and `/trading/health`.
- Add a repair queue section that ranks stale empirical replay, account quant backfill, symbol freshness repair,
  market-context refresh, H-MICRO feature/drift repair, and alert settlement by `profit_unlock_score`.
- Keep enforcement shadow-only until tests and two runtime samples pass.
- Add tests for aggregate-fresh/account-stale, account-stale pre-open, symbol-stale/table-fresh, stale empirical jobs,
  H-MICRO feature gaps, market-context stale, open critical alerts, and simple-submit disabled.

Jangar engineer scope:

- Provide the companion opening proof reconciliation epoch and expose it through stable status fields.
- Ensure stale alerts can only be netted by newer account/window proof refs.

Deployer scope:

- Before paper or live widening, capture the active packet id, Jangar epoch id, account, hypothesis, window, expiry,
  proof status, max notional, and required repairs.
- Do not use aggregate quant health as capital evidence.
- Keep live submission disabled until packet status reaches `live_candidate` and an activation receipt explicitly
  grants non-zero notional.

## Validation Gates

- Unit: aggregate fresh plus account stale yields `repair_only` and max notional `0`.
- Unit: table-wide ClickHouse freshness plus stale AAPL latest proof blocks H-CONT/H-REV paper probe.
- Unit: stale empirical jobs produce repair queue entries and block paper canary.
- Unit: H-MICRO cannot leave blocked state while feature rows or drift checks are missing.
- Unit: `simple_submit_disabled` blocks live micro-canary even if every proof surface is fresh.
- Integration: `/trading/status` includes opening packet id, Jangar epoch ref, proof status, expiry, required repairs,
  and max notional.
- Integration: `/trading/health` remains HTTP `503` for live capital while live submission is disabled, but exposes
  repair-only proof status.
- Runtime: pre-open validation records account-scoped quant freshness for `PA3SX7FYNUTF`, symbol freshness for the
  active universe, and empirical job age.

## Rollout Plan

1. Implement the packet builder behind a shadow flag.
2. Add unit tests for the false-green and stale-proof cases.
3. Expose packet fields in `/trading/status` only.
4. Add `/trading/health` payload fields without changing HTTP semantics.
5. Enable repair queue ranking with max notional `0`.
6. After two clean sessions, allow `paper_probe` when proof packets are fresh and Jangar epochs are present.
7. Keep live micro-canary disabled until paper closure receipts and broker/TCA evidence are current.

## Rollback Plan

- If packet generation is noisy, hide it from health while keeping logs and tests.
- If Jangar epoch consumption fails, keep packet status `repair_only` and max notional `0`.
- If repair ranking is wrong, fall back to deterministic ordering: empirical replay, account quant backfill, symbol
  freshness, market context, H-MICRO feature/drift, alert settlement.
- If a paper probe creates unexpected rejects, return the ladder to `observe` and require a fresh closure receipt.

## Risks

- Pre-open proof budgets can be too strict. Mitigation: tune budgets without allowing aggregate-only capital proof.
- Account labels can mismatch between Torghut and Jangar. Mitigation: packets must include account and broker refs.
- Stale alert settlement can hide real risk. Mitigation: only newer account/window proof can net an alert.
- The ladder can delay paper learning. Mitigation: zero-notional repair remains available and ranked by profit unlock.

## Handoff

Engineer acceptance:

- Implement the opening proof packet builder and tests.
- Prove aggregate-only quant health never authorizes paper or live capital.
- Prove stale empirical, account quant, symbol latest, market context, and alert evidence all keep max notional at `0`.
- Expose packet fields in status and health without changing current live-fail-closed behavior.

Deployer acceptance:

- For any paper or live widening, cite the packet id, Jangar epoch id, proof status, expiry, account, hypothesis,
  window, and max notional.
- Verify `PA3SX7FYNUTF` account-scoped proof and active universe symbol proof are fresh.
- Roll back to observe/shadow if the packet expires, if Jangar epoch status falls to `hold_capital`, or if critical
  scoped alerts reopen.
