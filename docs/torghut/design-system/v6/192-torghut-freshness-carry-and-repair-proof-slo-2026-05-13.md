# 192. Torghut Freshness Carry And Repair Proof SLO (2026-05-13)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: metrics/renderers, structured logs and OpenTelemetry, guardrail exporters, and operational manifests exist; full SLO/on-call process is mostly doc/runbook-level.
- Matched implementation area: Observability, metrics, traces, alerts, and operations.
- Current source evidence:
  - `services/torghut/app/metrics/core.py`
  - `argocd/applications/torghut/llm-guardrails-exporter.yaml`
  - `argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter.yaml`
  - `docs/torghut/production-readiness-proof-runbook.md`
- Design drift note: Operational docs need runtime status and alerting readback before being treated as complete.


## Decision

I am selecting a **freshness carry ledger with repair proof SLOs** as the Torghut companion contract for Jangar's
evidence-pressure governor.

The current Torghut posture is capital-safe but still not capital-ready. On the 2026-05-13 evidence pass, `/healthz`
returned HTTP 200, while `/readyz` and `/trading/health` returned HTTP 503 from the latest private Knative revision.
ClickHouse guardrail metrics showed both replicas reachable, no read-only replicated tables, and healthy disk, but
freshness was not uniform: `ta_signals` was current to `2026-05-12T20:57:00Z`, while `ta_microbars` trailed at
`2026-05-12T18:48:40Z`, and freshness queries had used low-memory fallback paths. That is a useful but incomplete
proof surface. It says some market data is alive; it does not say a routeable candidate should receive paper or live
capital.

The selected design makes freshness carry explicit. A stale or low-confidence market data surface becomes a priced
repair debt, not a generic `degraded` reason. Torghut emits a `freshness_carry_ledger` that states which dimensions are
current, which are stale, which are only exporter-derived, which repairs can retire the debt, and what profit hypothesis
the repair is allowed to test. Jangar consumes that ledger through the pressure budget: it may keep zero-notional repair
open, but it cannot treat partial freshness as capital readiness.

The tradeoff is that some promising route candidates will stay out of paper until their freshness receipt is tied to a
source-serving epoch and a post-cost profit hypothesis. I accept that because the trading objective is not to create
more signals. It is to create routeable, post-cost edge under guardrails we can falsify.

## Governing Runtime Requirements

Every run must cite the governing Torghut design or runtime requirement before changing code. Implementation stages
must produce production PRs that improve readiness, profit evidence, data freshness, execution quality, or capital
safety. Verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading
or evidence status after rollout. Final handoff must name the revenue metric improved or the smallest blocker
preventing revenue impact.

This design maps milestones to the value gates:

- `capital_gate_safety`: partial freshness keeps `max_notional=0`.
- `zero_notional_or_stale_evidence_rate`: stale freshness dimensions become explicit repair debts.
- `routeable_candidate_count`: a candidate is routeable only after freshness carry and source-serving receipts pass.
- `fill_tca_or_slippage_quality`: active TCA receipts must cite the freshness window they used.
- `post_cost_daily_net_pnl`: PnL claims must include freshness carry proof before paper or live graduation.

## Read-Only Evidence Snapshot

All assessment commands were read-only. I did not mutate Kubernetes resources, database records, GitOps resources,
broker state, trading flags, or AgentRuns.

### Cluster And Runtime

- Argo CD reported `torghut=Synced/Healthy` and the last Torghut operation succeeded at `2026-05-13T07:52:58Z`.
- Torghut core, sim, ClickHouse, keeper, guardrails exporter, websocket, technical-analysis, options, and database pods
  were Running. A `torghut-db-migrations` pod was Running during the evidence pass and logged database readiness plus
  Alembic transactional DDL.
- Recent Torghut events still included readiness/startup probe failures during rollout windows and an Error pod for a
  whitepaper autoresearch profit-target run. That is not direct trading readiness debt, but it is evidence that rollout
  and research repair status must remain separated.
- `torghut-options-catalog` returned `status=ok` with no recorded `last_success_ts`.
- `torghut-options-enricher` returned `status=ready` with `last_success_ts=2026-05-13T08:11:42.555315+00:00`.
- The latest Torghut private service returned HTTP `503` for `/readyz` and `/trading/health`, while `/healthz` returned
  HTTP `200` with `status=ok`.

### Data And Freshness

- ClickHouse guardrail exporter metrics were reachable and current at `2026-05-13T08:11:42Z`.
- Both ClickHouse replicas reported `clickhouse_up=1`.
- No replicated table reported read-only state.
- Disk free ratio was near `0.97` on both replicas.
- `ta_signals` max event timestamp was `2026-05-12T20:57:00Z`.
- `ta_microbars` max window end was `2026-05-12T18:48:40Z`.
- Freshness low-memory fallback counters were nonzero: `ta_signals=1`, `ta_microbars=24`.
- Direct ClickHouse SQL returned HTTP `401`, so this worker's permitted freshness surface is the guardrails exporter,
  not ad hoc SQL.
- Direct Postgres SQL was unavailable because this service account could not list secrets or create `pods/exec`.
  Torghut migration logs and runtime health are therefore the available read-only database evidence in this pass.

### Source

- Torghut already has source-serving proof, repair-bid settlement, route warrants, route evidence clearinghouse, and
  consumer evidence contracts.
- Jangar already consumes Torghut evidence through source-serving verdicts, repair-bid admission, clearance market,
  stage credit, and the proposed pressure ledger.
- The missing invariant is freshness carry: a repair receipt should state whether it retired a stale freshness
  dimension, whether the proof was direct DB/ClickHouse or exporter-derived, and whether the resulting route candidate
  has enough post-cost evidence to graduate.

## Problem

Torghut can be alive and still not be tradeable. It can even have fresh data in one table while another surface is stale
or only low-memory-estimated. The system needs to stop collapsing these states into one `degraded` label.

The concrete failure modes are:

1. `/healthz` can pass while `/readyz` and `/trading/health` fail.
2. `ta_signals` can be fresh while `ta_microbars` lags.
3. Exporter-derived metrics can be current while direct SQL is unavailable to the worker.
4. Low-memory freshness fallbacks can hide confidence loss if they are not attached to repair receipts.
5. Zero-notional repairs can run without saying which freshness debt they retired.
6. A route candidate can look profitable in a stale or partial evidence window.
7. Jangar can admit repair work without knowing whether that work will reduce stale evidence rate or routeability debt.

The result is safe but low-leverage repair: a lot of activity can happen without improving routeable profit evidence.

## Alternatives Considered

### Option A: Add More Refresh Jobs

The first path is to increase cron frequency for market context, technicals, and ClickHouse refreshes.

Advantages:

- Easy to implement.
- Increases raw data volume.
- May clear simple stale windows.

Disadvantages:

- Does not tie refreshes to routeability or post-cost profit.
- Can amplify pressure on ClickHouse and API dependencies.
- Does not distinguish direct proof from exporter-derived proof.
- Does not tell Jangar which repairs are worth a runner slot.

Decision: reject as the primary design. Refresh jobs should be scheduled by repair value, not by hope.

### Option B: Block All Torghut Repair Until `/readyz` Is Green

The second path is to hold all repair when readiness is 503.

Advantages:

- Strong capital safety.
- Simple operational boundary.
- Avoids receipts from unhealthy routes.

Disadvantages:

- Blocks the zero-notional repair needed to make readiness green.
- Turns a recoverable freshness gap into manual work.
- Gives no ordering among technicals, fundamentals, news, TCA, routeability, or source-serving repairs.

Decision: reject as the normal posture. Keep paper/live capital blocked, but keep bounded repair open.

### Option C: Freshness Carry Ledger With Repair Proof SLOs

The selected path emits a ledger over freshness dimensions, proof authority, repair value, and capital posture. It
allows repair only when the repair can produce a receipt that retires a named debt within a service-level window.

Advantages:

- Turns stale data into priced repair debt.
- Preserves zero-notional repair without granting capital.
- Lets Jangar pressure budgets admit only high-value freshness repairs.
- Connects market-data freshness to routeability and post-cost profit hypotheses.
- Gives deployers exact checks for green PR-to-healthy rollout.

Disadvantages:

- Adds another evidence payload.
- Requires repair receipts to carry proof authority and freshness windows.
- Holds paper candidates longer when freshness or source-serving proof is ambiguous.

Decision: select Option C.

## Architecture

Torghut publishes `freshness_carry_ledger` beside consumer evidence and route warrants.

```text
freshness_carry_ledger
  schema_version = torghut.freshness-carry-ledger.v1
  ledger_id
  generated_at
  fresh_until
  account
  source_serving_ledger_ref
  route_warrant_ref
  dimensions[]
  repair_proof_slos[]
  capital_posture
  jangar_pressure_refs[]
  value_gate_impacts[]
```

Each freshness dimension is explicit:

```text
freshness_dimension
  dimension_id                    # ta_signals | ta_microbars | fundamentals | news | regime | tca | empirical
  state                           # current | stale | missing | low_confidence | unknown
  proof_authority                 # direct_sql | clickhouse_exporter | app_health | migration_log | unavailable
  observed_at
  max_event_at
  lag_seconds
  low_memory_fallback_count
  stale_reason_codes[]
  required_repair_receipt
  max_notional = 0
```

Repair proof SLOs bind repair work to measurable outcomes:

```text
repair_proof_slo
  repair_id
  target_dimension_id
  target_value_gate              # zero_notional_or_stale_evidence_rate | routeable_candidate_count | tca_quality
  expected_delta
  max_runtime_seconds
  max_retries
  required_output_receipts[]
  stop_conditions[]
  promotion_condition
  rollback_target
```

Capital posture remains conservative:

```text
capital_posture
  decision                       # observe | repair_only | paper_candidate | live_candidate | block
  max_notional
  reason_codes[]
  required_freshness_dimensions[]
  required_source_serving_state
```

Decision rules:

- `/healthz` success is liveness only.
- `/readyz` and `/trading/health` failures keep paper/live blocked.
- A freshness dimension with only exporter proof can authorize zero-notional repair but not capital.
- A low-memory fallback increments proof debt unless the repair receipt includes a direct validation receipt later.
- Routeable candidates require current source-serving proof, route warrant pass, and all required freshness dimensions
  current for the candidate's account/window.
- Jangar may admit a repair only if it cites a `repair_proof_slo` and emits zero notional.

## Implementation Scope

Engineer milestone 1:

- Build a pure Torghut `freshness_carry_ledger` reducer.
- Populate dimensions from route evidence, consumer evidence, readiness status, ClickHouse guardrail metrics, TCA
  status, empirical jobs, and source-serving proof.
- Expose the ledger on `/trading/consumer-evidence`, `/trading/status`, and `/readyz` in observe mode.
- Add tests proving partial freshness keeps `max_notional=0` while admitting a bounded zero-notional repair SLO.

Implementation status:

- Phase 1 is implemented in `services/torghut/app/trading/freshness_carry.py` as a pure read-model reducer with no
  database writes, broker actions, or scheduler dispatch.
- Runtime surfaces now include `freshness_carry_ledger` on `/trading/consumer-evidence`, `/trading/status`,
  `/trading/health`, and `/readyz`.
- The first shipped dimensions are `ta_signals`, `tca`, `empirical`, `market_context`, `quant_evidence`, and
  `source_serving`. Any non-current dimension keeps `capital_posture.max_notional=0` and emits bounded repair SLOs
  with required output receipts.
- Source-serving proof is a dispatch precondition for non-source freshness repairs; if source-serving proof is stale,
  only the source-serving repair SLO is dispatchable.
- Phase 2 has started in `services/torghut/app/trading/zero_notional_repair_executor.py`: zero-notional execution
  receipts now cite the matching `freshness_carry_ledger` dimension and `repair_proof_slo` for market-context,
  empirical, and TCA freshness repairs. `execute=true` fails closed before runner invocation when that citation is
  missing or the SLO is not dispatchable.
- Phase 2 now also emits deterministic `jangar_pressure_refs` from each non-current freshness repair SLO. Each ref
  carries the freshness ledger id, repair SLO id, target value gate, required output receipt, TTL, dedupe key,
  `max_notional=0`, dispatchability, and hold reasons so Jangar can price Torghut freshness debt without
  reinterpreting the full ledger.

Engineer milestone 2:

- Require zero-notional repair receipts to cite a freshness dimension and repair proof SLO when the repair target is
  market context, technicals, TCA, empirical replay, or routeability.
- Add a direct-proof upgrade path so exporter-derived dimensions can be promoted after SQL/ClickHouse validation exists.
- Consume emitted Jangar pressure refs in pressure-ledger scheduling decisions after observe-mode parity is stable.

Deployer milestone:

- For Torghut PRs, prove Argo sync, pod readiness, `/healthz`, `/readyz`, `/trading/health`, source-serving proof,
  route warrant, and freshness carry state.
- Do not call a rollout capital-ready until freshness carry, route warrant, and source-serving proof agree.

## Validation Gates

Local validation for the Torghut implementation:

- `uv run --frozen pytest services/torghut/tests -k freshness_carry`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Cluster validation after deploy:

- `curl -fsS http://torghut-<revision>-private.torghut.svc.cluster.local/healthz`
- `curl -fsS http://torghut-<revision>-private.torghut.svc.cluster.local/readyz`
- `curl -fsS http://torghut-<revision>-private.torghut.svc.cluster.local/trading/health`
- `curl -fsS http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
- Confirm `freshness_carry_ledger` is present, fresh, and capital posture is `repair_only` until proof converges.

Acceptance gates:

- `zero_notional_or_stale_evidence_rate`: stale dimensions decline or produce exact blockers.
- `routeable_candidate_count`: no candidate counts as routeable without required freshness.
- `capital_gate_safety`: `max_notional=0` while readiness is 503 or freshness is partial.
- `fill_tca_or_slippage_quality`: repair receipts carry the freshness and source-serving epoch.
- `post_cost_daily_net_pnl`: no PnL claim graduates without freshness carry proof.

## Rollout

Phase 0 is this accepted architecture contract.

Phase 1 ships the ledger in observe mode. No capital or repair behavior changes.

Phase 2 requires freshness SLO receipts for zero-notional repairs that target stale data.

Phase 3 lets Jangar pressure-ledger consumers use freshness carry as a repair-value input.

Phase 4 considers paper-candidate promotion only after source-serving proof, route warrant, and freshness carry pass for
the same account/window.

## Rollback

Rollback is conservative:

- Set `TORGHUT_FRESHNESS_CARRY_LEDGER_ENABLED=false` to remove the new projection.
- Keep route warrants, repair-bid settlement, source-serving proof, and existing consumer evidence as fallback.
- Keep paper/live capital blocked while `/readyz` or `/trading/health` return 503.
- Preserve emitted freshness receipts for audit even when enforcement is disabled.

Rollback does not require database mutation, broker mutation, or live capital changes.

## Risks And Mitigations

- Risk: the ledger duplicates existing consumer evidence. Mitigation: it only prices freshness dimensions and repair
  proof SLOs; capital authority remains with route warrants and source-serving proof.
- Risk: exporter metrics are too weak for promotion. Mitigation: exporter proof can authorize repair only; capital
  requires direct or runtime contract proof.
- Risk: repair jobs chase stale dimensions without improving profit. Mitigation: every repair SLO names target value
  gate and expected delta.
- Risk: readiness 503 blocks all progress. Mitigation: read-only and zero-notional repair remain open.

## Handoff

Engineer:

- Build the ledger as a pure projection first.
- Keep capital posture at `repair_only` unless source-serving proof, route warrant, and required freshness dimensions
  pass together.
- Add receipt tests before any scheduler integration.

Deployer:

- Treat `/healthz` as liveness only.
- Treat `/readyz`, `/trading/health`, source-serving proof, route warrant, and freshness carry as the capital-readiness
  bundle.
- If freshness carry is stale, cite the dimension id, proof authority, lag, repair SLO, and rollback target.

The next bounded implementation milestone is:

```text
Add observe-mode freshness_carry_ledger to Torghut consumer evidence and readiness payloads, proving partial ClickHouse
freshness keeps max_notional=0 while opening a bounded zero-notional repair SLO for stale dimensions.
```
