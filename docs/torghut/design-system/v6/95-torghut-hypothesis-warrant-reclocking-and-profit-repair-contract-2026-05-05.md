# 95. Torghut Hypothesis Warrant Reclocking and Profit Repair Contract (2026-05-05)

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

Torghut should promote no hypothesis until it can cite a fresh **HypothesisEvidenceWarrant** and a reclocked
**ProfitRepairReceipt** for the current session. It should also stop treating stale empirical proof as a portfolio-wide
dead end when that proof is truthful and can be repaired for a specific lane.

The live system is broker-safe: capital is zero, live promotion is disabled, and all three hypotheses require rollback.
That is the correct posture. The problem is that the system is not yet profit-competent. It can say "blocked," but it
cannot say which repair creates the most expected post-cost edge for a given hypothesis, nor can it price the difference
between stale truthful proof and missing proof.

I am choosing a **HypothesisWarrantReclocker** and a **ProfitRepairQueue**. The reclocker consumes Jangar evidence
warrants, Torghut empirical-job status, signal continuity, feature/drift coverage, TCA, market context, and quant-health
status. It emits one warrant per hypothesis/account/session with a capital decision and a repair recommendation. The
profit repair queue ranks zero-notional repairs by expected ability to reopen paper/live gates.

The tradeoff is that we will delay capital reentry until reclocking is explicit. I accept that because the current
evidence shows signal lag measured in thousands of seconds, zero feature rows, zero drift checks, stale March empirical
jobs, timed-out quant-health, and average absolute slippage far above every manifest budget. A new strategy name will
not fix that. Better evidence clocks and repair economics will.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Runtime Evidence

- Torghut live pod `torghut-00224-deployment-787547645-x4phf` and sim pod
  `torghut-sim-00305-deployment-6c6d68799c-t2kvc` were both `2/2 Running`.
- Torghut events showed the latest live and sim revisions became ready, but only after startup and readiness probe
  failures, including request timeouts on the Knative queue-proxy route.
- ClickHouse pods were running, but events repeatedly warned that ClickHouse pods match multiple PodDisruptionBudgets
  and that the keeper PDB has no matching pods.
- Options catalog and enricher were running, but recent events showed options readiness HTTP 503 during rollout.
- The agents namespace had current Torghut discover/verify workflow activity, with recent failed and succeeded runs.
- Direct Deployment/StatefulSet reads and database exec were forbidden to the worker identity, so the design must rely
  on durable route/status evidence and exported metrics for normal assessment.

### Torghut Route Evidence

- `/healthz` returned `ok`.
- `/trading/status` returned `running=true`, `mode="live"`, active revision `torghut-00224`, and
  `last_decision_at=2026-05-04T17:25:57.901670Z`.
- `/trading/health` returned HTTP 503.
- `/db-check` timed out after 8 seconds.
- `/trading/empirical-jobs` returned `ready=false`, `status="degraded"`, `authority="blocked"`, and
  `stale_after_seconds=86400`.
- The stale empirical jobs were `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.
- Each stale empirical job had `truthful=true`, `promotion_authority_eligible=true`, persisted authority
  `empirical`, dataset `torghut-full-day-20260318-884bec35`, candidate `intraday_tsmom_v1@prod`, and S3 artifact refs.

### Jangar Dependency Evidence

- Jangar `/health` returned `ok`.
- Jangar control-plane status returned `dependency_quorum.decision="block"` with reason `empirical_jobs_degraded`.
- Jangar execution trust was `degraded` because the Jangar verify stage was stale.
- The collaboration runtime kit was healthy and now found the NATS tooling required for live coordination.
- Jangar quant-health for Torghut timed out after 10 seconds.
- Torghut consumed the Jangar block and reported `alpha_readiness_dependency_quorum_decision="block"`.

### Source and Data Evidence

- Hypothesis manifests are source-controlled under `services/torghut/config/trading/hypotheses`.
- `H-CONT-01` expects 6 bps gross edge, requires signal feed and TCA, and allows no more than 12 bps average absolute
  slippage.
- `H-MICRO-01` expects 10 bps gross edge, requires microstructure and order-book features, and allows no more than
  8 bps slippage.
- `H-REV-01` expects 8 bps gross edge, requires market context, and allows no more than 12 bps slippage.
- All three manifests require signal lag below 90 seconds before promotion.
- Live status observed signal lag around 2,233 seconds, zero feature batch rows, zero drift checks, unavailable market
  context freshness for the event-reversion path, 13,775 TCA orders, and average absolute slippage around
  568.61 bps.
- Metrics confirmed three loaded hypotheses, zero promotion-eligible hypotheses, and three rollback-required
  hypotheses.
- `services/torghut/app/trading/hypotheses.py` compiles runtime status from manifests, signal lag, feature rows,
  drift checks, evidence continuity, market context, TCA, and Jangar dependency quorum.
- `services/torghut/app/main.py` exposes `/trading/status`, `/trading/health`, `/trading/empirical-jobs`, and the
  live submission gate that consumes empirical jobs and quant evidence.
- Tests cover hypothesis compilation, Jangar dependency quorum loading, empirical-jobs endpoint behavior, quant-health
  submission council failures, and trading API status surfaces. The missing test target is a session-level reclocking
  object that joins those signals into one per-hypothesis repair and capital decision.

## Problem

Torghut can block unsafe capital, but it cannot yet convert a block into a ranked, measurable repair plan.

The runtime knows the pieces:

- gross edge targets from manifests;
- live signal lag and signal continuity;
- feature and drift coverage;
- Jangar dependency quorum;
- empirical job lineage;
- quant-health route health;
- TCA cost evidence;
- capital stage and rollback state.

Those pieces are still mostly assembled route-by-route. The system needs one durable, session-scoped object that says:

1. which evidence subjects are fresh enough for this hypothesis;
2. which subjects are stale but truthful and can be repaired;
3. what capital action is allowed now;
4. what repair action has the best expected post-cost value;
5. when the answer expires.

Without that object, every hypothesis inherits the same stale empirical block. That is safe, but it is not profitable.

## Alternatives Considered

### Option A: Keep Every Hypothesis at Shadow Until All Global Gates Are Green

Maintain the current broad hold posture and wait for Jangar status, empirical jobs, quant-health, feature rows, drift
checks, signal lag, and market context to all return healthy.

Pros:

- Very low capital risk.
- Matches current runtime behavior.
- Easy to explain to deployers.

Cons:

- Does not rank repairs.
- Does not distinguish stale truthful evidence from missing evidence.
- Does not identify which hypothesis has the best option value after repair.
- Keeps profitability dependent on manual sequencing.

Decision: keep as the emergency fallback, not the next architecture.

### Option B: Add More Hypotheses and Let Shadow Trading Discover an Edge

Use the existing source-controlled manifest framework to add new alpha lanes, especially microstructure and options
lanes, while capital remains disabled.

Pros:

- Increases research surface.
- Uses existing manifest and status machinery.
- Keeps live capital safe.

Cons:

- Adds proof load while the proof system is stale.
- Does not address signal lag, feature rows, drift checks, empirical freshness, or quant-health timeouts.
- Can create more shadow noise without improving capital eligibility.
- Risks optimizing on stale March artifacts.

Decision: reject for this lane. Research expansion should follow proof repair.

### Option C: Hypothesis Warrant Reclocking and Profit Repair Queue

Compile a per-hypothesis warrant for the current session, then rank zero-notional repairs by expected ability to reopen
post-cost capital gates.

Pros:

- Converts the global block into hypothesis-local repair work.
- Keeps paper/live capital closed until evidence is fresh and post-cost.
- Gives Jangar a typed consumer of lane-local evidence warrants.
- Makes stale truthful empirical jobs useful as repair inputs without letting them fund capital.
- Creates measurable acceptance gates for engineer and deployer stages.

Cons:

- Adds a new session object and repair queue.
- Requires careful expiry and lineage checks.
- May keep capital at zero through the first rollout while the reclocker is shadowed.

Decision: select Option C.

## Chosen Architecture

### HypothesisEvidenceWarrant

```text
hypothesis_evidence_warrant
  warrant_id
  market_session_id
  hypothesis_id
  account_scope
  evidence_subjects
  empirical_warrant_refs
  quant_health_ref
  signal_continuity_ref
  feature_coverage_ref
  drift_governance_ref
  market_context_ref
  tca_ref
  jangar_lane_quorum_ref
  proof_capacity_lease_ref
  gross_edge_bps
  cost_drag_bps
  net_edge_bps
  capital_decision          # hold, repair_only, paper_probe, live_probe, scale
  repair_priority_score
  reason_codes
  observed_at
  fresh_until
```

Rules:

- `capital_decision=hold` when any required evidence subject is missing, stale untrusted, or contradictory.
- `capital_decision=repair_only` when required evidence is stale but truthful and the repair has positive option
  value.
- `paper_probe` requires fresh empirical, quant-health, signal, feature, drift, market-context when applicable, and TCA
  evidence for the session.
- `live_probe` additionally requires live submission gates, critical toggle parity, broker safety, and Jangar capital
  lane quorum.
- A warrant expires at the end of the market session or earlier if any required evidence subject expires.

### ProfitRepairReceipt

```text
profit_repair_receipt
  receipt_id
  warrant_id
  hypothesis_id
  repair_kind               # empirical_refresh, quant_health_repair, signal_lag_repair, feature_coverage, tca_reprice
  expected_gate_reopened
  expected_net_edge_delta_bps
  proof_cost_budget
  capacity_lease_ref
  started_at
  completed_at
  status                    # queued, running, succeeded, failed, expired
  output_evidence_ref
  reason_codes
```

Rules:

- Empirical refresh cannot be queued unless it names the stale job type and target dataset or replay window.
- Quant-health repair cannot be queued without a Jangar route SLO warrant and timeout budget.
- Signal-lag repair must prove whether market-closed staleness is expected or whether the signal feed is behind.
- Feature-coverage repair must name the missing feature set and dependent hypotheses.
- TCA reprice must reconcile average absolute slippage and realized shortfall before capital can reopen.

### ProfitRepairQueue

The queue ranks repairs with a simple first version:

```text
repair_priority_score =
  expected_net_edge_delta_bps
  * affected_hypothesis_count
  * evidence_truthfulness_weight
  / max(1, proof_cost_budget)
```

Initial truthfulness weights:

- `eligible`: 1.0
- `expired_truthful`: 0.7
- `missing`: 0.2
- `stale_untrusted`: 0.0 until manually inspected or regenerated

The queue may recommend zero-notional repair while capital is held. It may not recommend paper or live capital without
fresh warrants.

## Measurable Trading Hypotheses

1. `H-CONT-01` can only leave shadow when signal lag is below 90 seconds, empirical warrants are eligible for
   benchmark parity and foundation-router parity, TCA slippage is below 12 bps, and net edge is at least 6 bps after
   cost drag.
2. `H-MICRO-01` can only enter repair-only state until microstructure feature rows and drift checks are present. It
   cannot enter paper probe unless slippage is below 8 bps and empirical plus feature warrants are eligible.
3. `H-REV-01` can only enter paper probe when market-context freshness is below 120 seconds, event-reversion empirical
   warrants are eligible, signal lag is below 90 seconds, and net edge is at least 8 bps.
4. Any hypothesis with a stale truthful empirical warrant can receive repair priority, but not capital.
5. Any hypothesis whose route SLO or quant-health warrant is missing remains `hold` even if local Torghut status is
   otherwise healthy.

## Implementation Scope

Engineer stage:

- Add a pure reclocking module under `services/torghut/app/trading/hypothesis_warrants.py`.
- Compile `HypothesisEvidenceWarrant` from existing manifest, hypothesis runtime status, empirical jobs, quant evidence,
  TCA, market context, and Jangar lane quorum payloads.
- Add `ProfitRepairReceipt` payload builders for empirical refresh, quant-health repair, signal-lag repair, feature
  coverage, and TCA reprice.
- Extend `/trading/status` with additive `hypothesis_warrants` and `profit_repair_queue` blocks.
- Keep existing `hypotheses` and `control_plane_contract` payloads backwards-compatible.
- Add focused tests in `services/torghut/tests/test_hypothesis_warrants.py` and route tests proving stale truthful
  empirical jobs become repair-only, not capital-eligible.

Deployer stage:

- Roll out the new blocks in shadow mode.
- Keep live/paper capital gates closed until the reclocker has one full market-session sample with no contradictory
  warrants.
- Enable repair queue execution only after Jangar lane-local quorum supports `torghut_repair`.
- Keep `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false` until paper probes produce fresh post-cost evidence.

## Validation Gates

- Unit tests prove every current manifest compiles into a warrant.
- Unit tests prove the March 21 stale truthful empirical jobs create `repair_only` decisions and do not reopen capital.
- Unit tests prove signal lag above 90 seconds blocks all paper/live decisions.
- Unit tests prove feature rows and drift checks only block hypotheses that require those capabilities.
- Route tests prove `/trading/status` remains backwards-compatible and adds warrant refs.
- Integration smoke after deploy checks `/healthz`, `/trading/status`, `/trading/empirical-jobs`, `/trading/health`,
  and Jangar quant-health.
- Manual validation records the current DB limitation if direct SQL remains forbidden: use service endpoints and
  exported metrics, then ask platform for read-only SQL only if route evidence is insufficient.

## Rollout

1. Ship the reclocker as a pure shadow projection.
2. Publish warrant summaries through Jangar/NATS so the owner can see which hypothesis is repairable first.
3. Connect the repair queue to Jangar lane-local `torghut_repair` warrants, still zero-notional.
4. Reclock empirical jobs after a fresh replay or empirical refresh and compare old versus new warrant decisions.
5. Enable paper probes only for hypotheses with fresh warrants and positive post-cost net edge.
6. Consider live probes only after paper probes survive the rollback windows in the manifests.

## Rollback

- Disable warrant projection consumption and keep the existing global dependency quorum behavior.
- Keep generated warrant history for audit, but stop using it for capital or repair.
- If a warrant incorrectly allows capital from expired evidence, set every affected hypothesis to `hold`, invalidate the
  warrant refs, and require a new empirical refresh.
- If repair execution increases route latency or pod pressure, pause the repair queue and keep only read-only status
  projection.

## Risks

- The first priority score may over-rank empirical refresh when the real blocker is signal lag or TCA. The repair
  receipt must record which gate reopened and which remained blocked.
- A stale truthful artifact can be operationally tempting. The contract is explicit: it can prioritize repair, not
  capital.
- Direct database evidence is still limited by RBAC. The reclocker should depend on service-owned status contracts
  first and request narrower read-only SQL later only if needed.
- TCA currently reports enough order count but too much slippage for the manifest budgets. The allocator must treat
  cost drag as a blocker, not a noisy metric.

## Handoff Contract

Engineer acceptance:

- The PR adds the pure reclocker, payload builders, `/trading/status` additive fields, and tests.
- Current route fields remain backwards-compatible.
- Stale truthful empirical jobs, quant-health timeout, signal lag, feature gaps, drift gaps, market-context gaps, and
  TCA slippage each produce explicit reason codes.

Deployer acceptance:

- Shadow deployment shows one warrant per current hypothesis and a ranked repair queue.
- No paper/live capital gate opens during shadow mode.
- Repair execution is enabled only when Jangar lane-local quorum admits `torghut_repair`.

Owner acceptance:

- The owner handoff names the first repairable hypothesis, the stale evidence warrant it depends on, the proof cost
  budget, and the exact capital gate that remains closed.
