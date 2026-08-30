# 124. Torghut Data-Plane Proof Quarantine And Profit-Renewal Fuse (2026-05-06)

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

Torghut will publish a **data-plane proof quarantine** and pass every profit-renewal bid through a
**profit-renewal fuse** before the bid can affect paper or live capital state.

The current cluster says why this matters. Torghut live and sim services answer route checks, the database schema is
current, and the latest live/sim service revisions are running. That is not enough. The sim technical-analysis lane is
in `ImagePullBackOff` because the promoted `torghut-ta` digest has no platform manifest for the scheduled node.
Empirical jobs are still stale, sim quant latest metrics are empty, live quant proof is stale or not wired into live
readiness, market context is stale, and the options catalog reports ready with no success timestamp.

Torghut should not ask Jangar for repair capacity or paper capital against proof produced by a data lane that cannot
prove its image, runtime, and freshness. A profit-renewal bid must name the data-plane witness it depends on. The
capital shadow ledger may record what the bid would unlock after closure, but it must keep live notional at `0` while
any dependent witness is quarantined.

The tradeoff is that some high-value repairs wait behind registry and runtime evidence. I accept that. The profitable
move is not to run more stale jobs faster. It is to make every repair spend produce evidence that could actually clear
a capital gate.

## Evidence Snapshot

All checks were read-only. I did not mutate Kubernetes resources, database rows, trading flags, broker state, Argo CD,
or GitHub records.

### Runtime And Rollout Evidence

- Argo CD reported `torghut` as `Synced` and `Progressing` at revision
  `000d3b9750eaa04d4eb8238915fdff1a6450caec`.
- Live revision `torghut-00238` and sim revision `torghut-sim-00329` were running on Torghut image digest
  `af92e76b6844ec5614a0d00b3651713d8102f2ff25eaa6ceadf0be63c089483e`.
- Live TA, options TA, options catalog, options enricher, websocket, websocket options, ClickHouse, Keeper, Postgres,
  Alloy, and Symphony workloads were running.
- `torghut-ta-sim` was `0/1` available and pod `torghut-ta-sim-6df6f99967-h5rpt` was `ImagePullBackOff`.
- The quarantined image was
  `registry.ide-newton.ts.net/lab/torghut-ta@sha256:20fe1818a7c5239d58d4e3888804163025b9b3b2ee1a1674fd7db77007f682af`.
- Kubelet reported `no match for platform in manifest` for that digest.
- Torghut events also showed sim rollout startup/readiness misses that later cleared, a successful sim runtime-ready
  analysis, one failed sim activity analysis, duplicate ClickHouse PodDisruptionBudget matches, and Keeper PDB
  `NoPods`.

### Schema And Data Evidence

- Direct CNPG `psql` probes were blocked by service-account RBAC: the agents service account cannot create
  `pods/exec` in the `torghut` namespace. Routine deployer validation must rely on service projections unless a
  higher-privilege read-only database path is granted.
- `/db-check` returned HTTP `200`, `ok=true`, `schema_current=true`, `schema_graph_lineage_ready=true`, and
  `account_scope_ready=true`.
- Live `/readyz` returned HTTP `503` in about `4.9s`; live submission was blocked by `simple_submit_disabled` in
  `capital_stage=shadow`, and live quant evidence was informational because `quant_health_not_configured`.
- Live `/trading/health` returned HTTP `503` with `hypotheses_total=3`, `promotion_eligible_total=0`, and
  `rollback_required_total=3`.
- `/trading/autonomy` returned stale empirical jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`,
  and `janus_hgrm_reward`.
- The stale empirical jobs are tied to candidate `intraday_tsmom_v1@prod`, dataset
  `torghut-full-day-20260318-884bec35`, and March 21 empirical artifacts.
- `/trading/profitability/runtime` returned a 72-hour window with `decision_count=8`, `execution_count=0`, and
  `tca_sample_count=0`.
- Sim `/readyz` and `/trading/health` returned HTTP `200`, but quant evidence was degraded:
  `latest_metrics_count=0`, `empty_latest_store_alarm=true`, and no pipeline stages.
- Jangar live-account quant health for `PA3SX7FYNUTF`, `15m`, returned `latestMetricsCount=108`,
  `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z`, and `metricsPipelineLagSeconds=74590`.
- Jangar market-context health for `AAPL` was degraded: technicals freshness was `150798s`, fundamentals
  `4753776s`, news `4386963s`, and regime `150798s`.
- Jangar quant alerts returned `50` open alerts, including `37` critical alerts.
- Options catalog `/readyz` returned HTTP `200` and `ready=true`, but `last_success_ts=null`.
- Options enricher `/readyz` returned HTTP `200` with a current `last_success_ts`.

### Source Evidence

- `services/torghut/app/main.py` owns `/readyz`, `/db-check`, `/trading/health`, `/trading/autonomy`,
  `/trading/profitability/runtime`, trading status, decisions, executions, and data projections. It should expose
  compact witness and fuse state rather than grow into a broader request-time reducer.
- `services/torghut/app/trading/empirical_jobs.py` already verifies empirical artifact truthfulness, lineage,
  staleness, persisted authority, and promotion eligibility.
- `services/torghut/app/trading/submission_council.py` already validates typed Jangar quant health and capital-stage
  requirements before live submission.
- `services/torghut/app/trading/scheduler/pipeline.py` owns signal continuity, market-context observations, rejection
  accounting, LLM decision context, and order preparation. It should attach witness refs to repair bids, not bypass
  Jangar fuse decisions.
- Existing tests cover empirical jobs, market context, typed quant health, submission council, trading health,
  simulation parity, and quant readiness. The missing system-level test is bid ranking plus capital shadow settlement
  when a dependent data-plane runtime is in image quarantine.

## Problem

Torghut currently has route health, schema health, and stale proof. It also has a broken sim TA image. Those facts must
not collapse into one generic degraded state.

The sim route can be paper-ready while the sim TA lane cannot pull its image. The options catalog can say ready while
it has no success timestamp. Empirical jobs can be truthful but stale. Live quant proof can exist in Jangar while live
Torghut readiness says quant health is not configured. Market context providers can be configured and recently
successful while the bundle for a symbol remains stale.

This is a data-plane proof problem. Torghut should rank repairs by expected value, but every bid must first prove that
the lane producing the evidence is pullable, running, fresh, and in scope. Otherwise the system risks spending repair
capacity on evidence that cannot clear a capital gate.

## Alternatives Considered

### Option A: Continue The Profit-Renewal Bid Model Without Runtime Witnesses

Pros:

- Builds on the accepted capital shadow ledger.
- Keeps Torghut focused on profitability and repair value.
- Avoids another witness schema.

Cons:

- Does not prevent a bid from depending on an unpullable sim TA image.
- Can over-rank empirical replay while the simulator data lane is non-evidential.
- Leaves deployers to manually connect registry, rollout, route, and freshness evidence.

Decision: reject as sufficient.

### Option B: Hold All Torghut Repairs Until Every Health Surface Is Green

Pros:

- Very conservative for live capital.
- Easy to explain during incidents.
- Avoids false confidence from partial evidence.

Cons:

- Blocks independent zero-notional repairs that do not rely on the broken lane.
- Prevents market-context or quant-alert repair from progressing when scoped safely.
- Does not create a durable record of which lane actually held the capital gate.

Decision: reject as the normal operating model. Keep it as emergency posture for unknown failure ownership.

### Option C: Data-Plane Proof Quarantine And Profit-Renewal Fuse

Pros:

- Makes image/platform/runtime proof a first-class input to profit repair.
- Lets Torghut continue zero-notional observation and independent repair while quarantining affected lanes.
- Gives paper and live capital readmission an auditable evidence chain.
- Prevents stale empirical proof and empty sim metrics from being treated as paper readiness.
- Lets Jangar admit repair capacity with lane-level precision instead of broad Torghut freeze.

Cons:

- Requires additional witness and fuse payloads.
- Requires conservative defaults when data-plane evidence is missing.
- Adds one more validation layer before paper capital can resume.

Decision: select Option C.

## Architecture

Torghut emits a `torghut_data_plane_runtime_witness` for every lane that can produce capital-grade evidence.

```text
torghut_data_plane_runtime_witness
  witness_id
  generated_at
  expires_at
  lane                         # live_service, sim_service, live_ta, sim_ta, options_ta,
                               # options_catalog, options_enricher, empirical_replay,
                               # market_context, quant_pipeline
  desired_image_ref
  observed_image_ref
  image_pull_status            # pullable, pending, failed, unknown, not_applicable
  platform_status              # matched, no_platform_manifest, unknown, not_applicable
  rollout_status               # ready, progressing, failed, unknown
  runtime_status               # running, degraded, blocked, unknown
  route_status                 # ok, degraded, timeout, unavailable, not_applicable
  data_freshness_status        # fresh, stale, empty, not_applicable
  latest_success_at
  latest_metric_at
  evidence_refs
  closure_requirements
```

Every profit-renewal bid declares its dependent witnesses.

```text
torghut_profit_renewal_bid
  bid_id
  requested_jangar_lane_class
  stale_evidence_refs
  dependent_witness_refs
  expected_information_gain
  expected_profit_value_class
  capital_unblock_class
  max_notional
  guardrails
```

Jangar returns a `profit_renewal_fuse_decision`, and Torghut records that decision in the capital shadow ledger.

```text
torghut_profit_renewal_fuse
  fuse_id
  bid_id
  jangar_fuse_ref
  dependent_witness_refs
  decision                     # allow, hold, quarantine, deny
  blocked_reasons
  required_closure_receipts
  max_notional
  fallback_repair_class
```

```text
torghut_capital_shadow_ledger
  ledger_id
  account
  hypothesis_id
  candidate_id
  current_capital_stage
  shadow_decision
  required_witness_refs
  required_fuse_refs
  missing_receipt_refs
  live_notional_ceiling
  paper_notional_ceiling
  rollback_target
```

## Initial Quarantines And Fuses

`sim_ta_image_manifest_quarantine`

- Trigger: `torghut-ta-sim` image pull failed with `no_platform_manifest`.
- Holds: `sim_quant_bootstrap`, `paper_canary`, and any empirical replay that claims sim TA freshness.
- Allowed: image rollback, digest promotion repair, and unrelated zero-notional observation.

`empirical_replay_freshness_hold`

- Trigger: required empirical jobs are stale.
- Holds: paper and live capital.
- Allowed: zero-notional empirical replay only after the runtime witness for the replay lane is current.

`live_quant_wiring_hold`

- Trigger: live route reports `quant_health_not_configured`, while Jangar live-account quant proof is stale.
- Holds: live micro-canary and live scale.
- Allowed: live quant wiring and account/window latest-store repair with `max_notional=0`.

`market_context_stale_hold`

- Trigger: selected symbol domains are stale.
- Holds: LLM-backed paper or live capital claims.
- Allowed: scoped market-context rehydration when the bid names candidate, symbol set, provider, and closure receipt.

`options_catalog_timestamp_hold`

- Trigger: options catalog readiness has `last_success_ts=null`.
- Holds: options-informed strategy bids that cite catalog freshness.
- Allowed: options catalog proof timestamp repair.

## Measurable Trading Hypotheses

Hypothesis 1:

- If Torghut requires data-plane runtime witnesses on every profit-renewal bid, then paper-capital eligibility will no
  longer be inferred from a running sim route while sim TA image evidence is failed.
- Success metric: any active `ImagePullBackOff` in a dependent lane produces a quarantine fuse and paper canary stays
  held.

Hypothesis 2:

- If the sim TA image manifest is repaired or rolled back before sim quant bootstrap, `TORGHUT_SIM` latest metrics will
  move from empty to non-empty with pipeline stages present.
- Success metric: `latest_metrics_count > 0`, `stage_count > 0`, and no active sim TA image quarantine.

Hypothesis 3:

- If stale empirical replay waits for current runtime witnesses, the next replay closure will retire
  `empirical_jobs_degraded` without producing a false paper-capital receipt.
- Success metric: all four required empirical jobs fresh, truthful, lineage complete, and tied to current witness ids.

Hypothesis 4:

- If market-context and options repairs are fused separately from sim TA, independent data repair can progress while
  paper capital remains held.
- Success metric: AAPL market-context domains move inside thresholds and options catalog records non-null
  `last_success_ts`, but capital remains blocked until empirical and sim quant witnesses close.

## Guardrails

- `max_notional` is always `0` when any dependent witness is quarantined.
- `simple_submit_disabled` remains a hard live-submission block.
- A running route is not sufficient proof when the data-producing lane is failed, stale, or empty.
- Expected profit value is an ordering signal, not realized PnL.
- A fuse decision may only relax after a fresh witness and closure receipt, not after time alone.
- If witness generation fails, Torghut must fail closed for paper and live capital while keeping observe routes open.

## Implementation Scope

Torghut engineer stage:

1. Add a pure data-plane witness builder that reads existing service projections, build image metadata, route status,
   latest success timestamps, quant health, and empirical job state.
2. Add witness refs to profit-renewal bids.
3. Add Jangar fuse refs and dependent witness refs to the capital shadow ledger.
4. Add tests for the current sampled state: sim TA image manifest failure, stale empirical jobs, empty sim quant
   latest store, stale live quant metrics, stale market context, and options catalog ready with no success timestamp.
5. Keep the first implementation observe-only until Jangar consumes the fuse.

Jangar engineer stage:

1. Consume Torghut witness refs in the repair admission governor.
2. Return fuse decisions with lane-level blocked reasons and closure requirements.
3. Keep action budgets aligned with fuse decisions.

## Validation Gates

- `/db-check` remains HTTP `200`, schema-current, lineage-ready, and account-scope-ready.
- Torghut publishes a `sim_ta` witness that marks the current failed digest as `image_pull_status=failed` and
  `platform_status=no_platform_manifest`.
- A profit-renewal bid that depends on `sim_ta` receives `decision=quarantine` and `max_notional=0`.
- Sim quant bootstrap cannot close until sim TA is pullable, running, and quant latest metrics are non-empty.
- Empirical replay cannot unlock paper until the empirical jobs are fresh and every dependent witness is current.
- Market-context repair can close independently, but it cannot unlock paper/live capital alone.
- Options catalog repair must produce non-null `last_success_ts` before options-informed bids can cite it.

## Rollout Plan

1. Emit witnesses in shadow mode from current route and rollout evidence.
2. Attach witness refs to bids without changing capital behavior.
3. Enable Jangar fuse decisions for `sim_quant_bootstrap` and `paper_canary`.
4. Extend fuse enforcement to empirical replay, market-context, options proof, and live quant wiring.
5. Require fuse closure before paper canary, then live micro-canary, then live scale.

## Rollback Plan

- Ignore fuse decisions and fall back to existing live-submission, dependency-quorum, and submission-council blocks.
- Keep witness publication observable for deployer triage.
- If witness data is wrong, require direct deployer evidence for the affected lane before any bid can close.
- If the fuse blocks too much, use a fixed scoped quarantine for `sim_ta` only while preserving independent repair.

## Handoff

Engineer handoff:

- Build the witness and fuse surfaces before changing scheduling behavior.
- Use the current `torghut-ta-sim` image-platform failure as the first regression case.
- Do not let empirical replay, sim quant bootstrap, or paper canary advance from a route-only health signal.

Deployer handoff:

- Before paper canary, capture: Torghut data-plane witness ids, Jangar fuse id, pullable image digest or rollback
  digest, sim quant latest metrics, empirical replay closure receipts, market-context freshness proof, options catalog
  success timestamp, and capital shadow ledger decision.
- If any dependent witness is failed, stale, or empty, keep live notional at `0` and leave paper canary held.
