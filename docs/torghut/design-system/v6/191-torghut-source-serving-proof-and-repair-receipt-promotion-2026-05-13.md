# 191. Torghut Source-Serving Proof And Repair-Receipt Promotion (2026-05-13)

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

I am selecting **source-serving proof with repair-receipt promotion** as Torghut's next quant architecture step.

The current live system is capital safe but not contract converged. Torghut `/healthz` returns HTTP 200, the live and
sim pods are running, and `/trading/consumer-evidence` returns HTTP 200. The route warrant is doing its job: it reports
`warrant_state=repair_only`, `max_notional=0`, `accepted_routeable_candidate_count=0`,
`zero_notional_or_stale_evidence_rate=0.9`, ten witnesses, nine non-current witnesses, and nine zero-notional repair
packets. That keeps capital safe.

The problem is that source and serving proof disagree. The repository and Argo sync revision are at `4dfa7c707`, and
source includes `repair_bid_settlement_ledger` in `/readyz`, `/trading/status`, and `/trading/consumer-evidence`.
The live Torghut build reports commit `cd846e937d5aedfbb332644fe4dc41fbfd85881d`, build version
`v0.569.1-96-gcd846e937`, `image_digest=null`, and no `repair_bid_settlement_ledger` field in the observed payloads.
That means route warrants can block capital, but Jangar cannot yet trust the newer repair-bid settlement contract on
the serving image.

The decision is to make source-serving proof part of every Torghut repair and profit receipt. A repair receipt should
not graduate a stale evidence lot unless it states the source SHA, manifest digest, serving revision, runtime build
commit, runtime image digest, and the contract schemas that were observed on the live route. Paper and live capital
remain zero while this proof is missing or contradictory. Zero-notional repair can continue, but every repair has to
produce a receipt that can be compared against the serving source epoch.

The tradeoff is slower promotion. I accept that because a routeable candidate produced by a stale serving image would
be worse than no routeable candidate. The revenue metric is post-cost profit evidence that can actually be routed; that
requires proof that the runtime serving the evidence is the runtime we reviewed and promoted.

## Governing Runtime Requirements

Every run must cite the governing Torghut design or runtime requirement before changing code. Implementation stages
must produce production PRs that improve readiness, profit evidence, data freshness, execution quality, or capital
safety. Verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading
or evidence status after rollout. Final handoff must name the revenue metric improved or the smallest blocker
preventing revenue impact.

This design maps milestones to the value gates:

- `capital_gate_safety`: source-serving mismatches keep `max_notional=0`.
- `zero_notional_or_stale_evidence_rate`: missing contract canaries become first-class stale evidence.
- `fill_tca_or_slippage_quality`: active TCA repair receipts must cite the serving source epoch that computed them.
- `routeable_candidate_count`: a candidate can become routeable only after its receipt was produced by the active
  source-serving proof epoch.
- `post_cost_daily_net_pnl`: daily net PnL claims must include source-serving proof before they can graduate from
  repair evidence to paper/live evidence.

## Read-Only Evidence Snapshot

All assessment commands were read-only. I did not mutate Kubernetes resources, database records, GitOps manifests,
broker state, trading flags, or AgentRun objects.

### Cluster And Runtime

- Argo reported `torghut` `Synced/Degraded`, while `jangar` and `torghut-options` were `Synced/Healthy`.
- The Torghut application sync revision was `4dfa7c70771f3f8d6f3884c52a77c41e5e851638`.
- Live revision `torghut-00332` and sim revision `torghut-sim-00430` were running with ready pods.
- The Torghut manifest currently pins `registry.ide-newton.ts.net/lab/torghut@sha256:d1be1975b0f0dd02ecb3ff1d5eb240dd88df9ef3c0bea53ab0f31021339d4a3b`.
- `/trading/status` reports build commit `cd846e937d5aedfbb332644fe4dc41fbfd85881d`, build version
  `v0.569.1-96-gcd846e937`, active revision `torghut-00332`, and `image_digest=null`.
- `/healthz` returned HTTP 200. `/readyz` and `/trading/health` returned HTTP 503.
- `/trading/consumer-evidence` returned HTTP 200, so the earlier route-missing class has improved. The new gap is
  contract/source convergence, not route existence.
- Recent events showed successful revision readiness, completed migration and backfill jobs, readiness/startup probe
  failures during rollout, and transient Knative status update failures for old revisions.

### Source

- `services/torghut/app/main.py` is now `6259` lines and imports `build_repair_bid_settlement_ledger` and
  `build_route_warrant_exchange`.
- Source returns `repair_bid_settlement_ledger` and `route_warrant_exchange` from `/readyz`, `/trading/status`, and
  `/trading/consumer-evidence`.
- Source contains focused tests for route warrants, repair-bid settlement, route evidence clearinghouse, consumer
  evidence, TCA refresh, zero-notional repair execution, and revenue repair digests.
- Source after the live build commit includes `d93df0917 ci(torghut): preserve main source runs`,
  `4929afa3a feat(torghut): compact route repair bids`,
  `3511a50da fix(torghut): retire stale jangar trading labels`, and
  `4dfa7c707 fix(torghut): rank only blocking revenue repairs`.
- The missing invariant is not another route. It is proof that the serving route exposes the contract set from the
  source SHA that release promotion and deployer verification claim.

### Database And Data

- Readiness reports database schema current at head `0031_autoresearch_candidate_spec_epoch_uniqueness`, expected head
  count `1`, current head count `1`, and lineage ready.
- Account-scope checks report ready, with a warning that checks are bypassed while multi-account trading is disabled.
- The service account cannot list Torghut secrets or create `pods/exec`, so direct read-only SQL was unavailable from
  this workspace. The smallest unblocker for row-level DB inspection is a read-only DB credential or explicit
  service-account permission for read-only SQL execution.
- Live route warrant evidence still contains enough data to classify the blocker:
  - `warrant_state=repair_only`
  - `max_notional=0`
  - `accepted_routeable_candidate_count=0`
  - `zero_notional_or_stale_evidence_rate=0.9`
  - `repair_packet_count=9`
  - `blocking_reason_count=38`
- Route evidence clearinghouse reported forty-nine selected repair bids, zero routeable candidates, and
  `zero_notional_or_stale_evidence_rate=1.0`.
- Active TCA proof is stale or incomplete for routing: latest execution created at
  `2026-04-02T19:00:29.586040+00:00`, average absolute slippage `13.8203637593029676` bps, and expected shortfall
  sample count `0`.
- ClickHouse guardrails report both replicas reachable, no read-only replicated tables, disk free ratio near `0.97`,
  `ta_signals` newest event `2026-05-12T20:57:00Z`, and `ta_microbars` newest window end `2026-05-12T18:48:40Z`.

## Problem

Torghut can now publish route warrants, but it cannot yet prove that every repair and profit receipt came from the
source epoch that deployer, Jangar, and capital gates think is live.

The concrete failure modes are:

1. The live build commit can lag the Argo sync revision.
2. The runtime can omit `image_digest`, which prevents manifest-to-runtime digest comparison.
3. The source contract set can include `repair_bid_settlement_ledger` while the serving payload lacks it.
4. Route warrants can correctly hold capital, but repair admission still cannot trust newer settlement fields that are
   absent on the live image.
5. Active TCA, empirical, and profit-signal repairs can produce receipts without carrying the source-serving epoch that
   generated them.
6. A future paper candidate could be counted from source-level code review rather than serving-level proof if this gap
   is not closed.

The next architecture layer has to bind repair receipts to serving source truth.

## Alternatives Considered

### Option A: Trust Source And Wait For The Next Rollout

Assume the current source is correct because tests pass and Argo is synced. Let the next image promotion converge the
runtime naturally.

Advantages:

- Minimal code and process change.
- Avoids adding more proof fields to already large status payloads.
- Keeps engineer focus on routeability and TCA repairs.

Disadvantages:

- Current evidence already shows source and serving disagreement.
- A later rollout can repeat the mismatch if CI source runs or runtime metadata are incomplete.
- Jangar cannot safely admit repair-bid settlement work when the serving contract is absent.

Decision: reject.

### Option B: Block All Repair Until Source And Serving Match

Hold all zero-notional repair work while the live build commit, manifest digest, image digest, and contract canaries
are unresolved.

Advantages:

- Strongest consistency boundary.
- Easy for capital safety.
- Avoids receipts from unknown serving epochs.

Disadvantages:

- Prevents the zero-notional work required to restore TCA, empirical, routeability, and source-serving proof.
- Keeps stale evidence rate high.
- Forces manual intervention for every contract drift.

Decision: reject as the normal posture. Keep it as a rollback state if receipts are malformed.

### Option C: Source-Serving Proof And Repair-Receipt Promotion

Keep read-only and zero-notional repair paths open, but require every repair receipt and every paper/live promotion
input to cite a current source-serving proof ledger. Paper/live remain blocked until the source-serving proof ledger
and route warrant both pass.

Advantages:

- Preserves capital safety without blocking useful repair.
- Turns missing runtime metadata and missing contract fields into typed repair work.
- Lets Jangar admit only repair packets that the serving image actually supports.
- Gives deployer and verifier stages exact post-rollout checks.
- Provides a clean bridge from zero-notional repair receipts to routeable candidate admission.

Disadvantages:

- Adds a proof ledger to already dense Torghut evidence payloads.
- Requires runtime build metadata to include an image digest.
- May hold paper candidates after code is merged until serving canaries converge.

Decision: select Option C.

## Architecture

Torghut publishes `source_serving_repair_receipt_ledger` beside route warrants and consumer evidence:

```text
source_serving_repair_receipt_ledger
  schema_version = torghut.source-serving-repair-receipt-ledger.v1
  ledger_id
  generated_at
  fresh_until
  account
  window
  source_commit
  source_ci_ref
  manifest_commit
  manifest_image_digest
  argo_sync_revision
  argo_health
  serving_revision
  serving_build_commit
  serving_image_digest
  route_ref
  required_contracts[]
  observed_contracts[]
  missing_contracts[]
  contract_schema_mismatches[]
  route_warrant_ref
  repair_bid_settlement_ref
  route_evidence_clearinghouse_ref
  repair_receipt_refs[]
  source_serving_state          # converged | source_ahead | serving_ahead | digest_unknown | contract_missing | unknown
  capital_decision              # observe | repair_only | hold | paper_candidate | live_candidate
  max_notional
  value_gate_impacts[]
  rollback_target
```

Each repair receipt must carry the source-serving epoch:

```text
repair_receipt_source_binding
  receipt_id
  receipt_schema
  generated_at
  target_value_gate
  target_dependency
  source_serving_ledger_ref
  serving_build_commit
  serving_image_digest
  required_input_contracts[]
  produced_output_contracts[]
  stale_reasons_retired[]
  stale_reasons_remaining[]
  max_notional = 0
  routeable_candidate_delta
  rollback_target
```

Decision rules:

- If `serving_build_commit` differs from `source_commit`, source-serving state is `source_ahead` or
  `serving_ahead`, and capital decision cannot exceed `repair_only`.
- If `serving_image_digest` is null, source-serving state is `digest_unknown`, and capital decision cannot exceed
  `repair_only`.
- If a source-required contract is absent from the live payload, source-serving state is `contract_missing`, and repair
  packets depending on that contract are held.
- If route warrants are `repair_only`, this ledger cannot widen capital even when source-serving proof converges.
- A repair receipt can reduce `zero_notional_or_stale_evidence_rate` only when it binds to a current source-serving
  ledger and names the retired stale reasons.
- `routeable_candidate_count` can increase only when route warrant, repair-bid settlement, active TCA, empirical
  replay, and source-serving proof all converge for the same account/window.

## Implementation Scope

Engineer milestone 1:

- Add a pure Torghut source-serving proof reducer that compares build metadata, manifest/source refs supplied by
  deployment metadata, route contract canaries, and observed payload contracts.
- Expose `source_serving_repair_receipt_ledger` from `/trading/status` and `/trading/consumer-evidence`.
- Add tests that prove `serving_build_commit != source_commit`, null image digest, and missing
  `repair_bid_settlement_ledger` all keep `max_notional=0`.

### Implementation Note (2026-05-13)

Engineer milestone 1 is implemented in observe mode. Torghut now publishes
`torghut.source-serving-repair-receipt-ledger.v1` on `/trading/status`, `/trading/health`, `/readyz`, and
`/trading/consumer-evidence`. The reducer compares the source commit, serving build commit, serving image digest,
manifest image digest, route warrant, repair-bid settlement ledger, route-evidence clearinghouse packet, and
consumer-evidence contract schemas. Source/serving commit splits, missing image digests, missing contract canaries, or
schema mismatches all keep `max_notional=0` and mark the ledger as repair-only evidence.

The Torghut release manifest updater now also writes `TORGHUT_IMAGE_DIGEST` into the live and sim Knative services so
newly promoted images can report the serving digest required by the ledger. Existing route warrants remain the capital
gate; the source-serving ledger adds contract convergence evidence without authorizing paper or live notional.

Engineer milestone 2:

- Bind `run_zero_notional_repair` receipts to the source-serving ledger.
- Require repair receipts for empirical replay, active TCA refresh, routeability acceptance, rollout image proof, and
  profit-signal quorum repair to include source-serving state and retired reason codes.
- Update revenue repair digest generation to rank only repairs whose required serving contracts are present.

Deployer milestone:

- Promote a Torghut image that reports the expected source commit and image digest at runtime.
- Verify `/trading/consumer-evidence` includes `route_warrant_exchange`, `repair_bid_settlement_ledger`, and
  `source_serving_repair_receipt_ledger`.
- Keep paper/live disabled until route warrants are beyond `repair_only` and source-serving proof is converged.

## Validation Gates

Local validation for this architecture PR:

- `bun test packages/scripts/src/torghut/__tests__/build-push-workflow.test.ts`
- `bunx oxfmt --check .github/workflows/torghut-ci.yml packages/scripts/src/torghut/__tests__/build-push-workflow.test.ts docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md docs/torghut/design-system/v6/191-torghut-source-serving-proof-and-repair-receipt-promotion-2026-05-13.md docs/agents/README.md docs/torghut/design-system/v6/index.md`
- `git diff --check`

Engineer validation:

- Unit tests for source ahead, serving ahead, null digest, missing contract, schema mismatch, and converged proof.
- Existing route-warrant and repair-bid settlement tests remain green.
- Existing trading API tests prove `/trading/status` and `/trading/consumer-evidence` include the ledger without
  replacing existing payloads.
- Regression test proves a repair receipt cannot retire stale evidence without a current source-serving ledger ref.

Deployer validation:

- `gh run list --workflow torghut-ci.yml --commit <source_sha>` shows the exact main source CI run retained and green.
- Argo `torghut` app sync revision equals the intended manifest source.
- Torghut runtime build commit and runtime image digest match the promoted source and manifest.
- `/healthz` is 200.
- `/readyz`, `/trading/health`, `/trading/status`, and `/trading/consumer-evidence` are captured after rollout.
- Capital remains `max_notional=0` while stale routeability, TCA, empirical, or source-serving evidence remains.

## Rollout

Phase 1 is already complete on `main` through PR `#6320`: exact main Torghut source CI runs are preserved by SHA. This
PR publishes the accepted architecture contract that binds those retained source checks to serving proof and repair
receipts.

Phase 2 adds the source-serving ledger in observe mode. The ledger reports mismatches but does not change existing
capital gates.

Phase 3 makes the ledger required for zero-notional repair receipt graduation. Repair work can launch only when its
required contracts exist on the serving image.

Phase 4 makes the ledger required for routeable candidate admission. `routeable_candidate_count` remains zero until
route warrants, repair-bid settlement, active TCA, empirical replay, and source-serving proof all pass for the same
account/window.

Phase 5 makes the ledger required for paper/live promotion. This phase should be no-op if the earlier gates are
correctly enforced, because capital already remains zero while route warrants are repair-only.

## Rollback

If the source-serving ledger is noisy, keep it in observe mode and continue using route warrants as the capital gate.
Do not remove the main source CI retention guard unless another exact-source evidence store exists.

If runtime image digest wiring fails, classify the state as `digest_unknown`, keep `max_notional=0`, and allow only
zero-notional repairs that do not depend on image provenance.

If a required contract canary blocks a valid backwards-compatible payload, add a versioned compatibility rule with an
explicit expiry. Do not disable all contract canaries.

If repair receipts fail source-binding validation, leave the stale reasons active and keep the repair packet queued at
zero notional.

## Risks

- The ledger can become another large status object. Mitigation: keep it as a compact reducer with refs to large
  payloads.
- Image digest may not be available inside the app environment. Mitigation: wire it through release metadata and keep
  null as a blocking but non-crashing state.
- Source-serving proof can hide unrelated readiness failures if treated as a global health bit. Mitigation: keep Argo,
  readiness, route warrant, and source-serving states separate.
- Repair receipts may retire stale reasons too aggressively. Mitigation: require exact reason-code retirement and keep
  unresolved reasons visible.

## Handoff

Engineer acceptance gate: implement `source_serving_repair_receipt_ledger`, expose it on Torghut evidence routes, and
prove with tests that mismatched source/build, null digest, and missing serving contracts keep `max_notional=0` and
block routeable candidate increases.

Deployer acceptance gate: after image promotion, prove retained source CI, Argo sync, serving build commit, serving
image digest, route-warrant presence, repair-bid settlement presence, source-serving ledger convergence, `/readyz`,
`/trading/health`, and `/trading/consumer-evidence`.

The next implementation improves `capital_gate_safety` and `zero_notional_or_stale_evidence_rate` immediately. The
smallest blocker preventing revenue impact is that live Torghut is still serving build metadata and contract fields
from an older source epoch; routeable candidates must stay at zero until source-serving proof and repair receipts
converge.
