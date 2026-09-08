# 105. Torghut Capital Reentry Evidence Feed And Readiness Debt Netting (2026-05-06)

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

I am choosing a **capital reentry evidence feed with readiness-debt netting** for Torghut.

The current Torghut state is operationally alive but not capital-authoritative. Live `/readyz` returned HTTP 503 with
healthy Postgres, healthy ClickHouse, active broker credentials, current Alembic head
`0029_whitepaper_embedding_dimension_4096`, and live submission blocked by `simple_submit_disabled`. Simulation
`/readyz` initially returned HTTP 200 because it is non-live paper mode, not because proof is ready; a later refresh on
revision `torghut-sim-00311` returned HTTP 503 because universe evaluation was not ready and quant latest metrics were
empty. Both live and simulation had three hypotheses, zero promotion-eligible hypotheses, and three rollback-required
hypotheses.

At the same time, Jangar had its own evidence-quality issue: a database holdback was caused by non-database AgentRun
pod names that contained `db` in generated suffixes. Torghut must not treat a broad Jangar holdback as a trading
truth. It needs a typed Jangar evidence feed and a local netting rule that separates operational readiness debt from
profitability proof debt. A refreshed Jangar status payload later reported valid database/source-schema leases and
allowed `torghut_capital`, which strengthens the point: Jangar operational evidence can recover before Torghut proof
quality does.

The selected design makes capital reentry a bounded exchange: Torghut consumes Jangar typed evidence, nets it with its
own proof-expiry clock, and emits one capital decision per account, hypothesis, and window. The tradeoff is slower
paper/live promotion. I accept that because the current evidence says the profitable action is repair: replay stale
empirical jobs, republish quant health, and retire readiness debt before adding notional risk.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, or trading settings were mutated.

### Cluster And Route Evidence

- `kubectl get pods -n torghut -o wide` showed live revision `torghut-00230` and simulation revision
  `torghut-sim-00311` running after the current image rollout.
- ClickHouse, Keeper, Torghut Postgres, websocket, Alloy, guardrail exporter, options catalog, options enricher, and
  options TA pods were running or rolling through the new revision.
- Recent Torghut events showed startup/readiness probe failures during Knative revision startup, then
  `LatestReadyRevisionName` updates to `torghut-00230` and `torghut-sim-00311`.
- The current refresh showed Torghut empirical, semantic, and whitepaper bootstrap Jobs completing during rollout. Older
  evidence still carried ClickHouse PDB ambiguity and Flink status-conflict debt as data-plane risks to keep scoped.

### Live Torghut Evidence

- `curl http://torghut.torghut.svc.cluster.local/readyz` returned HTTP 503 with `"status":"degraded"`.
- Scheduler, Postgres, ClickHouse, and Alpaca checks were individually `ok`.
- Database schema was current: current and expected heads were both `0029_whitepaper_embedding_dimension_4096`; there
  were no missing or unexpected heads.
- Migration lineage had parent-fork warnings for `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`, but no orphan parents or duplicate revisions.
- Universe source was `jangar`, `symbols_count` was 0, and `require_non_empty=true`.
- Empirical jobs were degraded but non-authoritative in current live readiness.
- DSPy live runtime was not active and its artifact hash was missing.
- Live submission gate was blocked: `allowed=false`, reason `simple_submit_disabled`, capital stage `shadow`,
  configured live promotion false, zero promotion eligibility.
- Alpha readiness reported three hypotheses: one blocked, two shadow, zero promotion eligible, and three rollback
  required.

### Simulation Evidence

- `curl http://torghut-sim.torghut.svc.cluster.local/readyz` returned HTTP 503 with `"status":"degraded"` in the later
  refresh.
- Simulation uses capital stage `paper`; live submission was allowed only because the mode is non-live.
- Simulation schema head matched live.
- Simulation dependency quorum still reported `block` on `empirical_jobs_degraded`.
- Quant evidence was informational but not current: source URL pointed to Jangar quant health for account
  `TORGHUT_SIM`, status was `degraded`, reason `quant_latest_metrics_empty`, latest metrics count was `0`, stage count
  was `0`, and the empty latest-store alarm was true.
- Alpha readiness matched live: three hypotheses, zero promotion eligible, and three rollback required.

### Jangar Consumer Evidence

- Jangar dependency quorum was `block` on `empirical_jobs_degraded`.
- Jangar empirical services named stale `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.
- Jangar failure-domain leases later allowed both `torghut_observe` and `torghut_capital` after database/source-schema
  evidence refreshed cleanly, while `deploy_widen` remained held by registry image-pull debt.
- The companion Jangar contract fixes a false database evidence match and requires typed authority before Torghut uses
  Jangar holdbacks for capital decisions.

## Problem

Torghut has enough signals to be safe, but not enough structure to be profit-authoritative:

1. Non-live simulation submission allowance can coexist with degraded proof readiness and zero promotion eligibility.
2. HTTP 503 live readiness can coexist with healthy storage and broker dependencies.
3. Stale empirical jobs and missing quant health are visible, but they are not netted into a current capital reentry
   decision.
4. Jangar holdbacks can be correct safety signals or projection bugs; Torghut needs typed evidence provenance before
   changing capital state.
5. Options rollout debt, ClickHouse PDB ambiguity, and Flink status conflicts can affect proof freshness without
   necessarily blocking all observation.

The economic risk is not only accidental live submission. It is spending research and execution capacity on hypotheses
whose proof is stale, missing, or contradicted by readiness debt.

## Alternatives Considered

### Option A: Keep Live Disabled And Let Humans Reopen Capital

Pros:

- Safe in the immediate state.
- Preserves the current `simple_submit_disabled` posture.
- Avoids a new feed and reducer.

Cons:

- Does not turn stale empirical jobs into bounded repair work.
- Does not distinguish Jangar projection bugs from true control-plane debt.
- Leaves paper promotion under-specified even when live stays disabled.

Decision: reject as the architecture. Manual approval remains a final live-control, not the repair mechanism.

### Option B: Trust Torghut Local Readiness Only

Pros:

- Keeps the trading service independent from Jangar projection bugs.
- Simple to implement because `/readyz` already has most fields.
- Makes paper simulation easy to resume.

Cons:

- Ignores Jangar as the source of universe and quant health context.
- Does not protect capital from control-plane dispatch or merge-readiness debt.
- Can treat a local HTTP 200 as proof readiness when latest quant metrics are unavailable.

Decision: reject.

### Option C: Capital Reentry Evidence Feed With Readiness-Debt Netting

Torghut consumes typed Jangar evidence and its own proof-expiry records, nets debt by action class, and emits compact
capital reentry decisions.

Pros:

- Separates observe, repair, paper, and live actions.
- Turns stale empirical jobs into measurable replay contracts.
- Prevents broad Jangar holdbacks from becoming trading truth without typed provenance.
- Lets options innovation proceed through explicit data readiness and PDB/Flink debt gates.
- Gives Jangar one compact `torghut_capital` input.

Cons:

- Requires a new reducer and payload tests.
- Slows promotion until both proof and readiness debt are current.
- Needs careful budget limits so repair lanes do not become unbounded research.

Decision: select Option C.

## Chosen Architecture

### CapitalReentryEvidenceFeed

Torghut should project one feed item per account, hypothesis, and proof window:

```text
capital_reentry_evidence
  account
  hypothesis_id
  strategy_family
  window
  generated_at
  fresh_until
  jangar_evidence_digest
  jangar_debt_state        # none, observe, repair_only, hold, block, unknown
  torghut_proof_state      # current, stale, missing, contradictory, blocked
  capital_decision         # observe_only, repair_only, paper_candidate, live_candidate, blocked
  expected_net_edge_bps
  realized_slippage_bps
  rejection_drag_bps
  max_drawdown_bps
  notional_cap_bps
  blocking_reason_codes[]
  required_repair_lanes[]
  artifact_refs[]
```

Reducer rules:

- If Jangar typed evidence is missing or contradicted, live capital is blocked and paper is capped at `repair_only`.
- If `promotion_eligible_total=0`, the decision cannot exceed `repair_only`.
- If live `simple_submit_disabled` is true, live capital is blocked regardless of proof state.
- If empirical jobs are stale, the record enters `empirical_replay`.
- If Jangar quant health fetch times out or latest metrics are empty, the record enters `quant_health_republish`.
- If the universe requires non-empty symbols and returns zero symbols, the record enters `universe_rebind`.
- If ClickHouse PDB ambiguity or Flink status conflicts recur inside the active window, options hypotheses stay
  observe-only until the data plane has one clean window.
- Only a current proof state, clean Jangar debt, non-empty universe, and positive net edge can produce
  `paper_candidate` or `live_candidate`.

### Measurable Hypotheses And Guardrails

The first reentry ladder should use bounded hypotheses:

- **Empirical replay repair**: rerun `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`; exit only when all are fresh inside the configured proof window.
- **Quant health republish**: require non-null latest metrics, non-zero pipeline stage count, and max stage lag under
  the account/window SLO before paper eligibility.
- **Universe rebind**: require `symbols_count > 0` from Jangar or a documented closed-market exception before paper or
  live capital.
- **Options data readiness**: require options catalog/enricher readiness plus no repeated Flink status conflicts in the
  active window before any options hypothesis leaves observe-only.
- **Profitability warrant**: require expected net edge to exceed rejection drag plus slippage by a configured margin,
  and require rollback if max drawdown or rejection drag breaches the hypothesis guardrail.

Initial numeric guardrails should be conservative:

- `notional_cap_bps=0` until a hypothesis is at least `paper_candidate`.
- `paper_candidate` requires expected net edge at least 2x estimated friction.
- `live_candidate` requires deployer approval, live submit enabled, clean Jangar debt, and one full proof window with
  no rollback-required hypotheses for the account.

### Jangar Contract

Torghut publishes a compact consumer payload:

```text
torghut_capital_reentry
  account
  window
  generated_at
  fresh_until
  capital_decision
  jangar_debt_state
  torghut_proof_state
  blocking_reason_codes[]
  required_repair_lanes[]
  artifact_refs[]
```

Jangar maps it as:

- `observe_only` allows `torghut_observe` and holds `torghut_capital`.
- `repair_only` allows bounded repair schedules and holds paper/live capital.
- `paper_candidate` allows paper proof only if Jangar typed evidence is clean.
- `live_candidate` still requires deployer approval and live submission controls.
- `blocked` holds all capital-adjacent actions.

## Engineer Handoff

Implement in five slices:

1. Add a pure reducer in Torghut that accepts readyz dependencies, alpha readiness, empirical jobs, quant evidence,
   live submission gate, and Jangar typed evidence.
2. Add tests for the current state: live blocked on `simple_submit_disabled`, simulation capped by
   `jangar_status_fetch_failed`, zero promotion eligibility capped at `repair_only`, and stale empirical jobs routed to
   `empirical_replay`.
3. Expose the feed in `/readyz` and `/trading/autonomy` as advisory data first.
4. Add a Jangar consumer only after one clean advisory cycle.
5. Add a dashboard tile that shows capital decision, proof state, Jangar debt state, and required repair lanes.

Acceptance gates:

- `uv run --frozen pytest services/torghut/tests/test_capital_reentry_evidence_feed.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- In-cluster live `/readyz` still blocks live submission while the feed reports `repair_only` or `blocked`.
- Simulation cannot report `paper_candidate` until Jangar quant health is reachable and promotion eligibility is
  non-zero.

## Deployer Handoff

Deploy advisory-first.

1. Roll out the feed without changing live submission behavior.
2. Verify live remains blocked while `TRADING_SIMPLE_SUBMIT_ENABLED=false`.
3. Verify simulation exposes the feed and stays below `paper_candidate` until quant health and promotion eligibility
   recover.
4. Verify Jangar consumes only typed evidence digests and compact Torghut capital decisions, not raw route health.
5. Enable paper reentry before live reentry, and only after one clean proof window.

Rollback:

- Disable or remove the advisory feed.
- Keep live submission disabled.
- Keep Jangar `torghut_capital` held until a fresh capital reentry decision is available.
- Do not delete empirical or rollout history to make a proof window look clean.

## Risks

- Jangar typed evidence may lag Torghut proof state. The feed must fail closed for live and allow only bounded repair.
- Empirical replay can consume too much compute if every stale job forks a new research lane. Budget the lane per
  account/window.
- Options data readiness can block profitable equity hypotheses if debt is netted globally. Debt must be scoped by
  strategy family and data dependency.
- Parent-fork migration warnings are currently lineage-ready, but they should stay visible because future schema
  ambiguity would invalidate proof replay.

## Open Questions

- What proof window should first gate paper reentry: one market session, one trading day, or one fixed replay sample?
- Should ClickHouse PDB ambiguity block only options data readiness, or all capital decisions that depend on
  ClickHouse features?
- Should Jangar expose an acknowledgement path for typed readiness debt, or should Torghut require only fresh evidence
  to retire debt?
