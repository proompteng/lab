# 182. Jangar Routeability Cutover Backpressure And Proof-Run Admission (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Gideon Park, Torghut Traders Architecture Lead
Scope: Jangar control-plane reliability, Torghut routeability acceptance cutover, proof-production backpressure,
scheduled repair admission, rollout safety, capital safety, validation, rollout, rollback, and handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/186-torghut-routeability-acceptance-cutover-and-fill-quality-loop-2026-05-08.md`

Extends:

- `181-jangar-proof-production-debt-and-routeability-admission-2026-05-08.md`
- `180-jangar-stage-clearance-exchange-and-scheduler-routability-contract-2026-05-08.md`
- `180-jangar-execution-trust-debt-retirement-and-profit-repair-settlement-2026-05-08.md`

## Decision

I am selecting **routeability cutover backpressure with proof-run admission** as Jangar's next control-plane contract
for Torghut quant.

The Jangar and agents deployments are healthy enough to run work. At `2026-05-08T16:12Z`, Argo reported `agents`,
`jangar`, `torghut`, and `torghut-options` as `Synced` and `Healthy`; `deployment/agents-controllers` was `2/2`;
Jangar `/ready` reported execution trust healthy; and runtime kits included NATS collaboration helpers. That is a real
improvement over the May 5 degraded execution-trust and controller-readiness soak.

The improved control plane must not turn into routeability authority. Torghut is still `repair_only`, live submission
is disabled, routeable candidates are zero, and the live runtime has not emitted the routeability acceptance ledger.
PR #6127 is a strong implementation candidate, but it exceeds the mandatory review threshold and is currently blocked
by Codex review capacity. Jangar must therefore distinguish four states: design accepted, PR green, PR merged, and
live payload present.

The selected design makes Jangar apply backpressure at proof-run admission. It may launch zero-notional repair work
only when the run cites a Torghut cutover lot and a value gate. It must hold routeable candidate claims, paper route
probes, live submission, capital increase, and slippage-threshold loosening until the live Torghut cutover packet is
present and accepted.

The tradeoff is less apparent swarm throughput. That is the right tradeoff. The business metric is routeable
post-cost profit evidence and live trading readiness without weakening capital safety, not the raw count of launched
AgentRuns.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps state, broker
state, trading flags, or AgentRun objects.

### Cluster And Control Plane

- `kubectl config current-context` is unset, but in-cluster read access works as
  `system:serviceaccount:agents:agents-sa`.
- Argo reports `agents`, `jangar`, `torghut`, and `torghut-options` as `Synced` and `Healthy`.
- `deployment/agents` is `1/1`; `deployment/agents-controllers` is `2/2`; `deployment/jangar` is `1/1`.
- Jangar service `jangar.jangar.svc.cluster.local` has endpoint `10.244.5.136:8080`.
- Jangar `/health` returns `status=ok`, but its serving process has local `agentsController.enabled=false`, which is
  correct for serving liveness and insufficient for action admission.
- Jangar `/ready` returns `status=ok`, execution trust healthy, runtime kits healthy, and collaboration helpers
  present, including `/usr/local/bin/codex-nats-publish`, `/usr/local/bin/codex-nats-soak`, and `nats`.
- Agents `/ready` returns `status=ok` and execution trust healthy, but local controllers are disabled in that serving
  process.
- Recent agents events still include readiness probe timeouts and `BackoffLimitExceeded` for scheduled proof work, so
  admission must continue to separate control-plane availability from useful proof production.

### Torghut Proof Consumed By Jangar

- Torghut `/healthz` returns HTTP 200.
- `/readyz` and `/trading/health` are degraded while service dependencies remain healthy.
- `/db-check` is current at expected Alembic head `0030_evidence_epochs`; direct database secret listing is forbidden
  for this service account, so runtime database contracts are the database evidence source.
- `/trading/status` reports live mode, running scheduler, live submission blocked by `simple_submit_disabled`, three
  observe-only profit-signal quorums, zero paper candidates, zero routeable candidates, and fourteen blocked or stale
  evidence cells.
- `/trading/revenue-repair` reports `business_state=repair_only`, `revenue_ready=false`, and blockers for alpha
  readiness, market context, submit gate, and quant pipeline stages.
- `/trading/consumer-evidence` reports seven zero-notional repair lots and route-proven profit state `repair`.
- `routeability_acceptance_ledger` is absent from the current live Torghut status, revenue repair, and consumer
  evidence payloads.
- Market context is degraded by stale news; Jangar's market-context route has healthy ClickHouse ingestion and
  providers, but the news domain exceeds its freshness budget.
- TCA evidence is historical: 7,334 orders exist, average absolute slippage is about `13.82` bps, and the latest
  execution timestamp is `2026-04-02T19:00:29Z`.

### Source Risk

- `services/jangar/src/server/supporting-primitives-controller.ts` is 3,325 lines and owns schedule generation,
  freeze behavior, and resource reconciliation. Proof-run admission should be a pure reducer consumed by this
  controller, not another large inline branch.
- `services/jangar/src/server/torghut-quant-runtime.ts` and `torghut-quant-metrics-store.ts` own quant runtime and
  metrics materialization; they are input providers, not capital authorities.
- Existing tests cover Jangar Torghut consumer evidence, quant runtime materialization, and controller scheduling
  behavior. The missing invariant is cutover backpressure: a healthy Jangar route plus degraded or ledger-absent
  Torghut payload must allow named repairs but hold routeability and paper/live action classes.

## Problem

Jangar has recovered enough control-plane health to run work, but Torghut has not yet produced acceptance-grade
routeability proof.

Without cutover backpressure:

1. A green implementation PR can be mistaken for a live payload.
2. A healthy Jangar `/ready` result can be mistaken for Torghut routeability.
3. Scheduled runs can produce more evidence volume without retiring a Torghut lot.
4. Routeability candidate claims can outrun fill-quality and scoped quant proof.
5. Deployer stages can ask several large payloads to infer a yes/no answer.
6. Capital safety can depend on humans remembering that proof floor and submit gate remain closed.

Jangar needs one admission decision for Torghut proof-producing work: does this run retire a named cutover lot while
keeping paper and live capital blocked?

## Alternatives Considered

### Option A: Let Existing Schedules Continue And Rely On Torghut Runtime Gates

Advantages:

- Smallest change to Jangar.
- Torghut already blocks live submission and proof floor.
- Keeps repair throughput high.

Disadvantages:

- Allows duplicate or low-value proof runs.
- Does not require a run to cite a cutover lot.
- Keeps Jangar blind to the difference between implementation PR state and live acceptance payload.

Decision: reject as the architecture. Torghut gates protect capital; Jangar still owns useful dispatch.

### Option B: Freeze All Torghut Quant Work Until The Acceptance Ledger Is Live

Advantages:

- Strong safety posture.
- Easy to explain.
- Prevents routeability inflation.

Disadvantages:

- Blocks the zero-notional repair work needed to settle the ledger.
- Treats quant-stage repair, context refresh, fill/TCA repair, and live submission as one risk class.
- Increases manual intervention because operators must decide what can safely run.

Decision: reject as default. Keep it as an emergency brake if controller quorum or capital-gate integrity regresses.

### Option C: Cutover Backpressure With Proof-Run Admission

Advantages:

- Allows only repair work that names a Torghut lot and value gate.
- Blocks paper/live/routeability claims while the live cutover packet is absent or unsettled.
- Keeps Jangar out of capital truth while still improving dispatch quality.
- Gives deployers a compact action-class decision.

Disadvantages:

- Adds one reducer and one status surface.
- Requires Jangar to consume versioned Torghut payload refs.
- Some runnable work will be held until it names a measurable proof outcome.

Decision: select Option C.

## Architecture

Jangar derives a proof-run admission packet:

```text
jangar_torghut_proof_run_admission
  schema_version
  generated_at
  swarm_name
  stage
  action_class
  torghut_revision
  torghut_cutover_packet_ref
  cutover_packet_present
  cutover_packet_decision
  torghut_revenue_repair_ref
  torghut_profit_signal_quorum_ref
  proof_debt_lot_ref
  value_gate
  routeability_claim_allowed
  repair_run_allowed
  blocked_action_classes[]
  hold_reasons[]
  rollback_target
```

Action classes:

- `quant_stage_repair`: allowed when it cites the scoped quant lot and keeps notional zero.
- `market_context_refresh`: allowed when it cites the stale domain lot.
- `route_tca_repair`: allowed when it cites missing or stale fill-quality lots.
- `alpha_readiness_evidence`: allowed when it cites promotion-eligibility debt.
- `forecast_registry_repair`: allowed when it cites forecast/promotion debt.
- `routeable_candidate_claim`: held until the Torghut cutover packet is present and accepted.
- `paper_route_probe`: held until at least one accepted lot has current fill-quality proof and Torghut allows paper.
- `live_submission` and `capital_increase`: held until Torghut capital gates separately allow them.
- `slippage_threshold_loosening`: blocked as a repair class unless a separate design approves it.

Rules:

- Jangar route health and AgentRun success cannot create `routeable_candidate_count`.
- A run admitted for repair must cite one value gate from `post_cost_daily_net_pnl`, `routeable_candidate_count`,
  `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, or `capital_gate_safety`.
- If `cutover_packet_present=false`, repair classes may run but routeability and capital classes are held.
- If Torghut reports `business_state=repair_only`, paper and live classes are held.
- If the fill-quality clock is stale, route/TCA repair may run but paper route probes are held.
- If direct database evidence is unavailable by RBAC, Jangar records an observer limitation and does not mark proof
  accepted from absence of data.

## Implementation Scope

Engineer milestone 1:

- Add a pure Jangar proof-run admission reducer with fixtures for ledger absent, ledger present but unsettled, and
  ledger accepted.
- Add tests where Jangar `/ready=ok` and Torghut `/readyz=degraded`; paper/live action classes must stay held.
- Add tests where a repair run is allowed only when it cites a Torghut lot and one value gate.

Engineer milestone 2:

- Wire the reducer into schedule generation in observe mode and publish the admission packet through Jangar status.
- Emit NATS/Jangar denial messages that name the held action class, lot, and next receipt required.

Engineer milestone 3:

- Enforce holds for `routeable_candidate_claim`, `paper_route_probe`, `live_submission`, `capital_increase`, and
  `slippage_threshold_loosening`.
- Keep zero-notional repair classes available when they cite current debt lots.

Deployer milestone:

- Verify Argo sync, workload readiness, Jangar `/ready`, Torghut `/readyz`, Torghut cutover packet presence, and the
  Jangar admission packet after rollout.
- Prove no paper/live action class is allowed while Torghut remains `repair_only`.

## Validation Gates

- `post_cost_daily_net_pnl`: Jangar cannot claim revenue improvement until Torghut records post-cost paper evidence.
- `routeable_candidate_count`: cannot increase from Jangar admission alone.
- `zero_notional_or_stale_evidence_rate`: every held action class must name the stale or missing proof lot.
- `fill_tca_or_slippage_quality`: route/TCA repair can run; paper probes require current fill quality.
- `capital_gate_safety`: all paper/live/capital-increase action classes are held while Torghut proof floor is
  `repair_only` or submit is disabled.

## Rollout

1. Publish proof-run admission decisions in observe mode.
2. Compare decisions with live Torghut revenue repair and consumer evidence for one market session.
3. Enable holds for routeability claims and paper/live action classes.
4. Allow zero-notional repair runs only when they cite lot and value-gate evidence.
5. Promote enforcement only after deployer verification shows fresh admission packets and no incorrect repair holds.

## Rollback

- Disable enforcement and keep observe-only admission payloads.
- Continue relying on Torghut proof floor and submit gate as capital safety.
- Hold all Torghut paper/live action classes if Jangar controller quorum drops below `2/2`.
- Do not loosen Torghut slippage, quant, market-context, alpha, or submit gates as rollback.

## Risks And Tradeoffs

- Payload coupling: Jangar depends on Torghut's versioned cutover packet. Mitigation: fail closed for action classes and
  allow diagnostics when schema is unknown.
- Throughput loss: some scheduled work will be held. Mitigation: allow repairs that cite lots and value gates.
- False proof debt: stale stage evidence can be instrumentation debt. Mitigation: count it as stale evidence until a
  receipt proves freshness.
- Review-capacity blocker: #6127 cannot merge until Codex review capacity is restored. Mitigation: record PR state as
  audit evidence only; do not promote routeability until runtime payloads settle.

## Handoff

Engineer handoff: implement the proof-run admission reducer after the Torghut cutover packet lands. The first code PR
must prove that healthy Jangar control-plane readiness plus missing Torghut acceptance payload allows named repair work
but blocks routeable candidate claims, paper probes, live submission, and capital increases.

Deployer handoff: verify observe mode first. Acceptance is a fresh Jangar admission packet, a live Torghut cutover
packet, no non-zero notional while Torghut is `repair_only`, and admitted repair runs tied to `quant_pipeline`,
`market_context`, `route_tca`, `alpha_readiness`, or `forecast_registry` lots.
