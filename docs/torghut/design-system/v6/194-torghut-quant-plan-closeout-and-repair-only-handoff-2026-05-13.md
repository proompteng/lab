# 194. Torghut Quant Plan Closeout And Repair-Only Handoff (2026-05-13)

Status: Accepted for plan-lane closeout and engineer/deployer handoff

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

I am closing the plan lane on the proof-exchange and authority-ledger architecture, and I am handing the next work to
engineer and deployer stages as a **repair-only value-gate milestone**.

The evidence no longer supports more plan-stage architecture before implementation. The architecture PRs are merged,
long-form, indexed, and still govern the system. The live service now exposes the typed surfaces that those documents
called for: proof floor, route warrant exchange, repair bid settlement, source-serving repair receipt ledger, freshness
carry, and consumer evidence status. Jangar also has a healthy quant metrics runtime and healthy control-plane
deployments.

The remaining business blocker is not architecture ownership. It is evidence quality. Torghut is serving current code,
but routeable candidates are still zero and live submission is still held by design. The next useful milestone is to
retire one repair-only blocker with a typed zero-notional outcome receipt, not to lower the capital gate.

The tradeoff is that we accept a slower path to revenue in exchange for not weakening the safety boundary. I want
routeable post-cost profit evidence before any paper or live notional changes. `max_notional=0`,
`simple_submit_disabled`, and shadow capital stay in place until the proof floor changes state through evidence.

## Governing Inputs

Business metric:

- Increase routeable post-cost profit evidence and live trading readiness without weakening capital safety.

Required value gates:

- `post_cost_daily_net_pnl`
- `routeable_candidate_count`
- `zero_notional_or_stale_evidence_rate`
- `fill_tca_or_slippage_quality`
- `capital_gate_safety`

Validation contract:

- Every run must cite the governing Torghut design or runtime requirement before changing code.
- Implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety.
- Verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout.
- Final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

## Current Evidence

Evidence in this closeout was refreshed read-only on 2026-05-13. I did not mutate Kubernetes resources, database
records, trading flags, broker state, or runtime data.

### PR And CI

- PR `#5390` merged at `c8530a79d388ee38ed726af93a544bea9a5779a1`.
- PR `#5408` merged at `ad00e8e7f2c98bab69a89a30c9d989f65318dcbc`.
- Both PRs passed semantic commit and semantic PR title checks. Deploy automerge enable jobs were skipped because the
  changes were documentation-only.
- The current local branch `codex/swarm-torghut-quant-plan` is based on `origin/main`.
- The remote head branch from the original PRs was deleted after merge, so any follow-on audit change must recreate
  the same head branch from current `main`.

### Cluster, Rollout, And Events

- Argo reports `agents`, `agents-ci`, `jangar`, `symphony-jangar`, `symphony-torghut`, `torghut`, and
  `torghut-options` as `Synced/Healthy`.
- Jangar pods are running. `jangar` is `2/2`, `bumba` is `1/1`, `jangar-db-1` is `1/1`, and `symphony-jangar` is
  `1/1`.
- Agents deployments are ready: `agents=1/1` and `agents-controllers=2/2`.
- Torghut active serving revisions are `torghut-00347` and `torghut-sim-00445`, both `2/2 Running`.
- Torghut core database, ClickHouse replicas, Keeper, TA, TA sim, options TA, websocket, options catalog/enricher,
  guardrail exporters, Alloy, and Symphony pods are running.
- Recent Torghut events show normal image-promotion rollout noise and successful migration/backfill jobs. A retained
  whitepaper autoresearch workflow is still failing with exit code `2`, but it is not a capital-unlock signal.
- RBAC blocks statefulset and Knative service/revision listing for this service account, so rollout truth is taken from
  Argo application health, deployments, pods, services, and typed service endpoints.

### Service And Data Status

- Torghut `/healthz` returned HTTP `200`.
- Torghut `/db-check` returned HTTP `200`, `ok=true`, schema current, expected/current head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing or unexpected heads, lineage ready, and only known
  migration parent-fork warnings.
- Torghut `/readyz` returned HTTP `503` with `status=degraded`.
- Torghut `/trading/status`, `/trading/revenue-repair`, and `/trading/consumer-evidence` returned HTTP `200`.
- Torghut `/trading/health` returned HTTP `503` for expected capital-safety reasons.
- Current build evidence is version `v0.569.1-187-g0a4ce485e`, commit
  `0a4ce485e3e336468839d3650e8ea1d2145a3779`, image digest
  `sha256:c62e82a9de7af99bdcc6592db4b4eff5e2904708d94ede7e84a5adfea864f30c`, and active revision
  `torghut-00347`.
- Jangar quant health returned HTTP `200`, `latestMetricsCount=4536`, `metricsPipelineLagSeconds=0`, runtime enabled,
  runtime started, and no missing pipeline health stages.
- Direct CNPG psql is blocked by `pods/exec` RBAC in both `torghut` and `jangar`. The smallest unblocker for direct
  row-level database evidence is read-only database credentials or read-only CNPG exec permission for this service
  account.

### Trading Evidence

- Live submission is blocked: `allowed=false`, reason `simple_submit_disabled`.
- Critical toggle parity is aligned.
- Proof floor state is `repair_only`, route state is `repair_only`, capital state is `zero_notional`, and
  `max_notional=0`.
- Alpha readiness has `3` shadow hypotheses, `0` promotion eligible, and `3` rollback required.
- Empirical jobs are fresh and truthful for candidate `chip-paper-microbar-composite@execution-proof`; eligible jobs
  include `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Route warrant summary has `10` witnesses, `3` current witnesses, `7` noncurrent witnesses, `7` repair packets, and
  `accepted_routeable_candidate_count=0`.
- Freshness carry has `6` dimensions, `2` non-current dimensions, `2` dispatchable repair SLOs, and
  `zero_notional_or_stale_evidence_rate=0.3333333333333333333333333333`.
- Source-serving is converged with `6` required contracts, `6` observed contracts, no missing contracts, no schema
  mismatches, and `repair_receipt_binding_count=0`.
- Repair-bid settlement has `35-36` raw repair bids across adjacent reads, `6` compacted lots, `5` selected lots,
  `3` dispatchable lots, `3` held lots, and `routeable_candidate_count=0`.
- Routeable candidate exchange reports `routeable_candidate_count=0`, `zero_notional_repair_lot_count=7`, and
  `rejected_candidate_count=3`.
- Execution TCA is not a clean unlock. It has `7334` orders, `7245` fills, latest computation
  `2026-05-13T05:32:37Z`, newest execution `2026-04-02T19:00:29Z`, average absolute slippage
  `13.8203637593029676` bps, one probing symbol, four blocked symbols, and three missing symbols.

### Source Assessment

- Torghut now has production surfaces for the architecture: `proof_floor.py`, `route_warrant_exchange.py`,
  `repair_bid_settlement.py`, `source_serving_repair_receipt.py`, `freshness_carry.py`, `consumer_evidence.py`,
  `revenue_repair.py`, `tca.py`, and scheduler safety/runtime modules.
- Jangar now has matching control-plane surfaces: `torghut-quant-runtime.ts`, `torghut-quant-metrics-store.ts`,
  `control-plane-torghut-consumer-evidence.ts`, `control-plane-repair-bid-admission.ts`,
  `control-plane-ready-truth-arbiter.ts`, `control-plane-stage-credit-ledger.ts`, and watch reliability modules.
- Regression coverage exists for source-serving receipts, route warrant exchange, route evidence clearinghouse, repair
  bid settlement, routeability repair acceptance, freshness carry, proof floor, TCA policy, trading API, quant metrics,
  Torghut consumer evidence, ready truth, stage credit, and repair-bid admission.
- The remaining test gap for this handoff is outcome settlement: a repair lot should only earn new dispatch credit when
  a typed receipt retires a named blocker or records a no-delta terminal outcome.

## Problem

The plan lane did its job: it split platform authority from economic authority and defined proof exchange contracts.
The live system now proves that the architecture direction is implementable, but the revenue metric has not moved
enough.

Current blockers are concrete:

1. `routeable_candidate_count` is still `0`.
2. `accepted_routeable_candidate_count` is still `0`.
3. `repair_receipt_binding_count` is still `0`.
4. `zero_notional_or_stale_evidence_rate` is non-zero because TCA confidence and market-context freshness remain
   incomplete.
5. Alpha readiness is not promotion eligible.
6. Live submit remains disabled, which is correct until the proof floor stops being `repair_only`.

## Alternatives Considered

### Option A: Continue Architecture Planning

This would add more design docs before implementation.

Advantages:

- Low runtime risk.
- More complete vocabulary for later stages.
- Easy to review as documentation.

Disadvantages:

- The governing contracts already exist and are merged.
- The live blocker is evidence quality, not missing design language.
- More architecture does not increase routeable post-cost profit evidence.

Decision: reject as the primary path.

### Option B: Move Toward Paper By Policy Exception

This would keep live submit disabled but loosen one or more repair-only gates to get paper evidence sooner.

Advantages:

- Faster apparent progress toward trading readiness.
- More paper fills could improve TCA evidence.

Disadvantages:

- It weakens `capital_gate_safety`.
- It bypasses the proof floor instead of improving it.
- It risks converting stale or missing evidence into execution activity.

Decision: reject. Capital safety is not the lever for this milestone.

### Option C: Repair-Only Outcome Receipts For The Highest-Value Blocker

This path keeps `max_notional=0` and requires one dispatchable repair lot to produce a typed outcome receipt that
changes a value gate.

Advantages:

- Directly targets `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, and
  `routeable_candidate_count`.
- Preserves the live submission hold.
- Gives Jangar a crisp outcome for admitted repair work.
- Creates a measurable acceptance gate for engineer and deployer stages.

Disadvantages:

- It may reduce apparent dispatch throughput because no-delta lots stop getting free credit.
- It requires tests across Torghut service payloads and Jangar admission/settlement consumers.
- It still will not authorize capital if alpha readiness remains failed.

Decision: select Option C.

## Implementation Scope

The next bounded engineer milestone should implement one repair-only outcome path end to end.

Minimum acceptable scope:

1. Cite this handoff plus the governing design being changed, usually doc `193` for Torghut or doc `189` for Jangar.
2. Select one active repair class from the current evidence: `market_context`, `tca`, or source-serving repair receipt
   binding.
3. Emit a typed zero-notional outcome receipt with source evidence before and after the repair.
4. Bind the receipt into `/trading/consumer-evidence`.
5. Show which reason code was retired or preserved.
6. Keep `max_notional=0`, live submit disabled, and capital stage `shadow`.

Preferred first target:

- Retire `market_context_freshness_missing` or lower TCA low-confidence evidence without expanding the route universe.

Acceptance gates:

- `repair_receipt_binding_count` increases above `0`, or the response names the exact typed blocker.
- `zero_notional_or_stale_evidence_rate` decreases below the current `0.3333333333333333333333333333`, or the response
  explains why the selected lot produced no delta.
- `routeable_candidate_count` remains safe at `0` unless proof floor, route warrant, and alpha readiness all agree.
- `capital_gate_safety` remains intact: `max_notional=0`, `simple_submit_disabled`, and no live order submission.
- Unit tests cover the receipt payload, Jangar/Torghut consumer interpretation, and no-delta rollback behavior.

## Rollout

Rollout is normal GitOps:

1. Merge a green implementation PR.
2. Let CI/CD publish and promote the image.
3. Confirm Argo `torghut`, `jangar`, and `agents` are `Synced/Healthy`.
4. Confirm active Torghut and Jangar pods are ready.
5. Confirm `/healthz`, `/db-check`, `/trading/status`, `/trading/revenue-repair`, and `/trading/consumer-evidence`
   respond as expected.
6. Confirm the typed receipt appears on the consumer evidence path.
7. Confirm `/readyz` may still be HTTP `503` if capital remains repair-only; that is acceptable when the reason is
   explicitly safe.

## Rollback

Rollback must not delete evidence.

If the implementation increases stale evidence, loses source-serving convergence, breaks Jangar admission, or changes
capital state unexpectedly:

1. Revert the implementation PR or promote the previous known-good image.
2. Keep live submit disabled.
3. Keep `max_notional=0`.
4. Preserve the failed receipt or no-delta receipt as audit evidence.
5. Re-run the smallest service and unit checks that cover the failed receipt path.

## Risks And Tradeoffs

- The system may stay revenue-inactive while evidence improves. That is acceptable; routeable proof is the revenue
  precursor.
- Direct SQL remains blocked for this worker. Deployer evidence should use typed service surfaces unless read-only
  database access is granted.
- TCA evidence is useful but not yet sufficient. Average absolute slippage remains above the strict guardrail, and four
  symbols are blocked while three are missing.
- Market context freshness is a clear value-gate target, but it must not become a routeability shortcut.
- Source-serving convergence is now healthy, but `repair_receipt_binding_count=0` means repair outcomes are not yet
  earning credit.

## Handoff To Engineer

Start with the current repair-only evidence, not a capital exception.

Implement a typed outcome receipt for one selected repair lot. My preference is `market_context_freshness_missing`
because it maps directly to `zero_notional_or_stale_evidence_rate` and avoids touching execution routes. If current
runtime evidence points to TCA instead, use TCA, but keep the route universe closed and record a no-delta outcome if
slippage quality does not improve.

Do not enable live submit. Do not increase notional. Do not treat Jangar admission as economic approval. The engineer
PR is successful when it makes one repair result measurable and safe to verify.

## Handoff To Deployer

After the engineer PR merges, verify the rollout through Argo, pods, service endpoints, and consumer evidence. The
expected good state can still be `readyz=503` if the proof floor remains `repair_only`. The deployer should report the
specific value gate that changed, the receipt id, the active image digest, the active revision, and the rollback target.

If the implementation cannot move a value gate, the deployer should name the smallest blocker:

- missing direct read-only database access;
- receipt payload absent from `/trading/consumer-evidence`;
- Jangar admission unable to see the receipt;
- no-delta repair outcome;
- capital safety conflict.

## Closeout Statement

The architecture lane is complete and merged. The revenue metric is still blocked by proof quality, not by missing
architecture. The next milestone is a zero-notional repair outcome receipt that improves a value gate while preserving
capital safety.
