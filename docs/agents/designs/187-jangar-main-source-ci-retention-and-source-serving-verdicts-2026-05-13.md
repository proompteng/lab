# 187. Jangar Main Source CI Retention And Source-Serving Verdicts (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar launch custody, Torghut source CI retention, image/source/serving proof, deployer verification,
capital safety, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/191-torghut-source-serving-proof-and-repair-receipt-promotion-2026-05-13.md`

Extends:

- `186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`
- `186-jangar-route-warrant-dispatch-custody-and-dependency-verdicts-2026-05-13.md`
- `178-jangar-source-serving-parity-escrow-and-route-independent-launch-passports-2026-05-08.md`
- `../torghut/design-system/v6/190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`
- `../torghut/design-system/v6/190-torghut-route-warrant-exchange-and-ingestion-proof-reentry-2026-05-13.md`

## Decision

I am selecting **main source CI retention with source-serving contract verdicts** as the next Jangar control-plane
contract for Torghut quant.

The current failure is not a broad outage. Jangar is `Synced/Healthy`, Torghut Options is `Synced/Healthy`, and the
Torghut service answers `/healthz` with HTTP 200. The failure is narrower: Argo reports Torghut synced to repository
revision `4dfa7c70771f3f8d6f3884c52a77c41e5e851638`, while the live Torghut `/trading/status` payload reports build
commit `cd846e937d5aedfbb332644fe4dc41fbfd85881d`, build version `v0.569.1-96-gcd846e937`, and `image_digest=null`.
The repository source at the synced revision includes the `repair_bid_settlement_ledger` contract in
`services/torghut/app/main.py`, but the live payload does not expose that contract. At the same time,
`route_warrant_exchange` is present and correctly keeps the system in `repair_only`, `max_notional=0`, and
`accepted_routeable_candidate_count=0`.

The decision is to stop treating green PR checks, a synced Argo revision, or a promoted digest as sufficient source
truth for Torghut quant. Jangar should require a source-serving verdict before it admits deploy widen, merge-ready,
paper support, or live support claims. The verdict must prove that the exact main source SHA had retained source CI,
the promoted image was built from that SHA, the serving runtime reports the same build commit and digest, and the
expected Torghut contracts are present on the live route. If any part is missing, Jangar may serve status and may
admit bounded zero-notional repair, but it must hold capital-adjacent action classes.

The tradeoff is that main branch CI runs are no longer cancelled by later main pushes. I accept the extra runner
retention because release promotion needs exact-source evidence. A cancelled source CI run is cheap in isolation and
expensive when it leaves deployers proving a digest against stale or missing evidence.

## Governing Runtime Requirements

Every Torghut quant run must cite the governing Torghut design or runtime requirement before changing code.
Implementation stages must improve readiness, profit evidence, data freshness, execution quality, or capital safety.
Verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
evidence status after rollout. Final handoff must name the revenue metric improved or the smallest blocker preventing
revenue impact.

This Jangar contract maps directly to the swarm value gates:

- `capital_gate_safety`: hold deploy widen, paper, and live while source-serving proof is missing or contradictory.
- `zero_notional_or_stale_evidence_rate`: make missing contracts and stale main source CI first-class repair evidence.
- `routeable_candidate_count`: do not allow routeable-count increases from a serving image that lacks the expected
  contracts.
- `fill_tca_or_slippage_quality`: require active TCA repair receipts to come from the same serving source epoch.
- `post_cost_daily_net_pnl`: only count profit evidence after source-serving proof ties the receipt to the active
  runtime.

## Read-Only Evidence Snapshot

All assessment commands were read-only. I did not mutate Kubernetes resources, database records, GitOps state,
broker state, trading flags, or AgentRun objects.

### Cluster And Rollout

- Argo reported `jangar` `Synced/Healthy`, `agents` `Synced/Healthy`, `agents-ci` `Synced/Healthy`,
  `symphony-jangar` `Synced/Healthy`, `symphony-torghut` `Synced/Healthy`, and `torghut-options`
  `Synced/Healthy`.
- Argo reported `torghut` `Synced/Degraded` at sync revision
  `4dfa7c70771f3f8d6f3884c52a77c41e5e851638`.
- Torghut core pods were running, including live revision `torghut-00332`, sim revision `torghut-sim-00430`,
  ClickHouse, Keeper, Postgres, TA, TA sim, WebSocket, options catalog, options enricher, and guardrail exporters.
- Recent Torghut events showed the new revisions becoming ready, but also readiness and startup probe failures during
  rollout and transient Knative status update errors for older revisions.
- Torghut `/healthz` returned HTTP 200. `/readyz` and `/trading/health` returned HTTP 503.
- `/trading/consumer-evidence` returned HTTP 200 and included `route_warrant_exchange`, but the live payload did not
  include `repair_bid_settlement_ledger`.

### Source And CI

- Repository `HEAD` was `4dfa7c707` on `codex/swarm-torghut-quant-discover`, matching `origin/main`.
- Source after `cd846e937` includes `4929afa3a feat(torghut): compact route repair bids (#6314)`,
  `3511a50da fix(torghut): retire stale jangar trading labels (#6313)`, and
  `4dfa7c707 fix(torghut): rank only blocking revenue repairs`.
- `services/torghut/app/main.py` imports `build_repair_bid_settlement_ledger` and returns
  `repair_bid_settlement_ledger` from `/readyz`, `/trading/status`, and `/trading/consumer-evidence` in source.
- The serving `/trading/status` build still reported commit `cd846e937d5aedfbb332644fe4dc41fbfd85881d` and
  `image_digest=null`, so live source truth lagged the repository source and the Argo sync revision.
- The source-retention fix is now present on `main` via `d93df0917 ci(torghut): preserve main source runs (#6320)`.
  Torghut CI pull requests still cancel superseded PR runs, while main pushes are grouped by `github.sha` and are not
  cancelled by later pushes.
- That fix closes the first evidence-retention gap, but it does not by itself prove that the promoted digest and
  serving runtime expose the source contract set.

### Runtime Evidence And Data

- Live `route_warrant_exchange` reported `warrant_state=repair_only`, `max_notional=0`,
  `accepted_routeable_candidate_count=0`, `zero_notional_or_stale_evidence_rate=0.9`, ten witnesses, one current
  witness, nine non-current witnesses, nine repair packets, and thirty-eight blocking reason codes.
- Live route evidence clearinghouse reported forty-nine selected repair bids, zero routeable candidates, and
  `zero_notional_or_stale_evidence_rate=1.0`.
- Live active TCA was stale for routeability: latest execution timestamp was `2026-04-02T19:00:29.586040+00:00`,
  average absolute slippage was `13.8203637593029676` bps, and expected shortfall sample count was `0`.
- Torghut schema status was current at Alembic head `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- The service account could not list Torghut secrets or create `pods/exec`, so direct SQL was not available from this
  workspace. The readiness payload still exposed schema lineage, account-scope status, and data freshness summaries.
- ClickHouse guardrail metrics reported both replicas up, no read-only replicated tables, disk free ratio near `0.97`,
  `ta_signals` max event time `2026-05-12T20:57:00Z`, and `ta_microbars` max window end `2026-05-12T18:48:40Z`.

## Problem

Jangar currently has no single admission verdict that reconciles source CI, release promotion, Argo sync, serving
runtime identity, and Torghut contract presence.

The failure modes are concrete:

1. A main source CI run can be cancelled before release promotion verifies that exact source SHA.
2. Argo can be synced to a revision while the live app reports an older build commit.
3. A promoted digest can be present in manifests while the runtime exposes `image_digest=null`.
4. Source can contain a required contract while the serving payload lacks it.
5. Torghut can be safe because route warrants block capital, but Jangar still cannot distinguish image/source drift
   from ordinary stale trading evidence.
6. Deployer and verify stages can prove rollout mechanics without proving the exact Torghut evidence contract set that
   capital and repair admission need.

This is a control-plane reliability problem, not just a Torghut endpoint gap.

## Alternatives Considered

### Option A: Treat Argo Sync As Source Truth

Use Argo `Synced` state and manifest image digest as enough proof that the serving runtime contains the source
contracts merged to `main`.

Advantages:

- No new status reducer.
- Matches common GitOps expectations.
- Fastest deployer path when rollout is healthy.

Disadvantages:

- The current evidence contradicts it: Argo sync revision is `4dfa7c707`, while the live build reports `cd846e937`.
- It does not detect missing live contract fields such as `repair_bid_settlement_ledger`.
- It weakens `capital_gate_safety` by allowing source intent to masquerade as serving behavior.

Decision: reject.

### Option B: Freeze All Torghut Dispatch Until Torghut Is Healthy

Hold every Torghut quant action while Argo is degraded, `/readyz` is 503, or the live build/source evidence is split.

Advantages:

- Strong safety posture.
- Simple to communicate.
- Prevents accidental paper or live support.

Disadvantages:

- Blocks the zero-notional repair work needed to converge source and serving truth.
- Does not preserve main source CI evidence for future promotions.
- Gives engineers no typed reason to fix CI retention, image provenance, or contract canaries first.

Decision: keep as an emergency brake, not the default operating model.

### Option C: Main Source CI Retention Plus Source-Serving Contract Verdicts

Retain exact main source CI runs, require deployer verification to compare source SHA, manifest digest, Argo revision,
runtime build metadata, and live contract canaries, then publish a Jangar verdict per action class.

Advantages:

- Directly addresses the observed source-serving split.
- Preserves proof needed by manifest-only release checks.
- Separates read-only and zero-notional repair from paper/live/deploy-widen action classes.
- Gives deployer and verifier stages a concrete contract to prove after image promotion.
- Maps every hold to a value gate and expected repair receipt.

Disadvantages:

- Uses more CI capacity on main because push runs are retained by SHA.
- Requires runtime contract canaries to stay versioned and small.
- May hold release claims after Argo sync until the serving runtime proves its source and contract set.

Decision: select Option C.

## Architecture

Jangar publishes `source_serving_contract_verdict` for Torghut action classes:

```text
source_serving_contract_verdict
  schema_version = jangar.source-serving-contract-verdict.v1
  verdict_id
  generated_at
  fresh_until
  repository
  source_sha
  source_ci_run_id
  source_ci_conclusion
  manifest_sha
  manifest_image_digest
  argo_sync_revision
  argo_health
  serving_revision
  serving_build_commit
  serving_image_digest
  required_contracts[]
  observed_contracts[]
  missing_contracts[]
  contract_schema_mismatches[]
  torghut_route_warrant_ref
  torghut_repair_bid_settlement_ref
  action_class
  decision                     # allow | repair_only | hold | block
  max_notional
  value_gate_impacts[]
  required_repair_receipts[]
  rollback_gate
```

Jangar also records `main_source_ci_retention_receipt` for each Torghut main push:

```text
main_source_ci_retention_receipt
  schema_version = jangar.main-source-ci-retention-receipt.v1
  repository
  workflow = torghut-ci
  source_sha
  concurrency_group
  cancel_in_progress
  retained_until
  required_jobs[]
  conclusion
```

Decision rules:

- Pull request CI can cancel superseded PR runs. Main push CI must be grouped by `github.sha` and must not be cancelled
  by later main pushes.
- `serve_readonly` can remain allowed when Jangar and Torghut status routes respond.
- `dispatch_repair` is allowed only for zero-notional repair packets whose required contracts are present on the
  serving runtime.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_support`, and `live_support` are held when source SHA,
  retained source CI, manifest digest, Argo revision, serving build commit, serving image digest, or contract canaries
  disagree.
- A synced manifest without matching runtime build metadata is `source_serving_mismatch`, not `ready`.
- Missing `repair_bid_settlement_ledger` is a repair blocker for Jangar lot admission, even if `route_warrant_exchange`
  is present and capital safe.

## Implementation Scope

The first concrete guardrail, Torghut CI source-run retention, is already present on `main` via PR `#6320`. This
architecture PR defines the next gate that must consume that evidence: Jangar source-serving verdicts.

Engineer milestone 1:

- Keep the Torghut CI concurrency change and regression test from PR `#6320` as required release evidence.
- Add a Jangar source-serving verdict reducer that consumes GitHub source CI status, Argo app status, Torghut runtime
  build metadata, and Torghut contract canaries.
- Expose the verdict in the control-plane status beside route-warrant dispatch custody.

Implementation note: the first Jangar reducer ships in observe mode as
`source_serving_contract_verdict_exchange`. It compares retained source CI hints, source/GitOps revision, optional
manifest digest, Torghut serving build metadata, and required contract canaries. Missing
`repair_bid_settlement_ledger`, missing serving image digest, or source/build disagreement keeps deploy widen,
merge-ready operational claims, paper support, and live support held or blocked while read-only status stays allowed.

Engineer milestone 2:

- Add a Torghut runtime source-serving proof payload to `/trading/status` and `/trading/consumer-evidence`.
- Include `BUILD_COMMIT`, serving revision, image digest, required contract schemas, and observed contract schemas.
- Make `repair_bid_settlement_ledger` presence a contract canary for repair-bid admission.

Deployer milestone:

- After image promotion, prove `torghut` Argo sync revision, manifest digest, serving build commit, image digest, and
  contract canaries before claiming operational readiness.
- Keep paper/live capital held until the verdict is current and Torghut route warrants are not repair-only.

## Validation Gates

Local validation for this PR:

- `bun test packages/scripts/src/torghut/__tests__/build-push-workflow.test.ts`
- `bunx oxfmt --check .github/workflows/torghut-ci.yml packages/scripts/src/torghut/__tests__/build-push-workflow.test.ts docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md docs/torghut/design-system/v6/191-torghut-source-serving-proof-and-repair-receipt-promotion-2026-05-13.md docs/agents/README.md docs/torghut/design-system/v6/index.md`
- `git diff --check`

Runtime validation for engineer/deployer stages:

- `gh run list --workflow torghut-ci.yml --commit <source_sha>` shows required source jobs retained and successful.
- Argo `torghut` is `Synced/Healthy` or its degradation is explicitly classified outside source-serving proof.
- Torghut `/trading/status.build.commit` equals the promoted source SHA or the release contract's exact source SHA.
- Torghut `/trading/status.build.image_digest` is present and equals the manifest digest.
- `/trading/consumer-evidence` includes both `route_warrant_exchange` and `repair_bid_settlement_ledger` when source
  requires both.
- `route_warrant_exchange.max_notional` remains `0` while routeability, active TCA, empirical replay, or source-serving
  proof is stale.

## Rollout

Phase 1 is already complete on `main`: Torghut CI preserves main source runs by SHA. This PR publishes the architecture
handoff that makes that evidence part of Jangar action custody. No runtime capital behavior changes.

Phase 2 adds Jangar source-serving verdicts in shadow mode. Jangar reports holds but does not yet block existing
non-capital work beyond current gates.

Phase 3 makes the verdict required for deployer ready claims, merge-ready operational claims, and Torghut repair-bid
admission.

Phase 4 allows zero-notional repair dispatch only when the required serving contracts are present and current. Paper
and live stay held until route warrants and source-serving proof both pass.

## Rollback

If retained main CI causes unacceptable queue pressure, roll back only the retention rule after adding an alternate
release evidence store that preserves source job conclusions by SHA. Do not roll back to branch-wide cancellation
without another exact-source proof path.

If source-serving verdicts over-hold dispatch, keep them in shadow mode and continue using route warrants for capital
gates. The rollback state is `serve_readonly=allow`, `dispatch_repair=route_warrant_only`, and all paper/live support
held by existing Torghut capital gates.

If a contract canary breaks because of a backwards-compatible schema evolution, add a versioned compatibility rule;
do not disable contract canaries globally.

## Risks

- GitHub run retention increases main CI use. Mitigation: keep PR cancellation, and later add retention TTLs or an
  evidence compactor.
- Runtime `image_digest` may remain null until Torghut wiring is fixed. Mitigation: classify null digest as
  `source_serving_unknown` and keep capital zero-notional.
- A serving build can have correct commit metadata but missing contract fields. Mitigation: require contract canaries,
  not just commit equality.
- Argo degraded state can have unrelated causes. Mitigation: record Argo health separately from source-serving proof
  and avoid conflating all degradation with source drift.

## Handoff

Engineer acceptance gate: Torghut CI retains exact main source runs, and Jangar can produce a source-serving verdict
that holds deploy widen, merge-ready operational claims, paper support, and live support when live Torghut build
metadata or contract canaries lag the source requirement.

Deployer acceptance gate: after the next Torghut image promotion, prove retained source CI for the source SHA, Argo
sync, serving build commit, serving image digest, `/readyz`, `/trading/health`, `/trading/consumer-evidence`, and the
presence of both route-warrant and repair-bid settlement contracts. Capital remains zero-notional until those proofs
and routeability gates are current.

The immediate metric improved is `capital_gate_safety`. The smallest blocker preventing revenue impact is source and
serving proof convergence: live Torghut must serve the source contracts that routeable profit evidence and repair
admission depend on before `routeable_candidate_count` can safely increase.
