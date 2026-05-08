# Torghut quant verifier release gate - 2026-05-08

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-08T13:42:00Z

## Final release refresh - 2026-05-08T13:42Z

This section supersedes the earlier snapshots below.

Final merge and rollout gate is go for the selected Torghut quant PRs. The governing runtime requirements were
`docs/torghut/design-system/v6/184-torghut-execution-trusted-profit-repair-settlement-2026-05-08.md`, which requires
profit-repair settlement evidence to keep live notional at zero until receipts settle, and
`docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`, which requires Torghut verify stages to prove
green PR checks, image promotion, Argo sync, live service health, and trading or evidence status after rollout.

Merged PRs:

- #6115, `fix(torghut): honor optional quant evidence in profit gates`, merged at
  `fa8a59fcffcf4b03777caccded1d3c2a26b1ac3f`.
- #6118, `chore(torghut): promote image fa8a59fc`, merged at
  `da9d831c2fda3afc7ed51f648965400b6fe2ce8e`, promoted Torghut digest
  `sha256:561bd5d42db9b3c03567f59d475b21df1cd9bbb6a7b50e8155c7375b087d3d77`.
- #6117, `feat(torghut): add profit repair settlement ledger`, merged at
  `fa3d104cb600392d0cc6a91eb6e8d6a08df5b74a`.
- #6119, `chore(torghut): promote image fa3d104c`, merged at
  `a03d81bfee930dbec160b85078b44ad7bfc840ee`, promoted Torghut digest
  `sha256:3b77bbd6fc7607d3f660cb2a1f8a4937f72359bff4929121a6086e166795ac98`.
- #6120, `chore(jangar): promote image fa3d104c`, merged at
  `74befb03e6df84d62b53f5732e0bcc6b90ef52d8`, promoted Jangar digest
  `sha256:e4fda889861d807265ca5638218431f8ad841bf08b54f8482bf73e43b8d71bf2`.

Merge gate evidence:

- #6115 had no review threads or review requests, was conflict-free, and all non-skipped checks were green before
  merge, including Torghut Pyright, bytecode/lint/migration guard, pytest shards, coverage, and quality signals.
- #6117 had no review threads, no review requests, `mergeStateStatus=CLEAN`, `mergeable=MERGEABLE`, and changed
  988 additions plus 2 deletions, below the 1000-line Codex review threshold.
- #6117 checks were green before merge: semantic commits, semantic PR title, `CI / check_changed_files`,
  `jangar-ci / lint-and-typecheck / run`, `agents-ci / validate`, `agents-ci / integration`, Torghut Pyright,
  bytecode/lint/migration guard, pytest shards 0-3, coverage, and quality signals.
- #6119 and #6120 release PR checks were green before auto-merge, including semantic checks, Argo lint,
  kubeconform, release-manifest gating, Jangar typecheck for #6120, and Torghut deploy automerge for #6119.
- Post-merge release workflows passed: `torghut-build-push` run `25557901556`, `torghut-release` run
  `25558175648`, `torghut-post-deploy-verify` run `25558264463`, `jangar-build-push` run `25557901570`,
  `jangar-release` run `25558419593`, and `jangar-post-deploy-verify` run `25558467878`.

Rollout evidence:

- Argo CD reports `torghut`, `torghut-options`, and `jangar` as `Synced` and `Healthy` at revision
  `74befb03e6df84d62b53f5732e0bcc6b90ef52d8`.
- `torghut-00310-deployment` and `torghut-sim-00408-deployment` are `1/1` ready, updated, and available on
  `registry.ide-newton.ts.net/lab/torghut@sha256:3b77bbd6fc7607d3f660cb2a1f8a4937f72359bff4929121a6086e166795ac98`.
- `torghut-options-catalog` and `torghut-options-enricher` are `1/1` ready, updated, and available on the same
  Torghut digest.
- The current pods have zero restarts for the Torghut live, sim, options catalog, and options enricher containers.
- Events show the #6119 migration job completed, new Knative revisions `torghut-00310` and `torghut-sim-00408`
  became ready, and old revisions scaled down. The remaining warnings were transient startup/readiness probes during
  rollout plus pre-existing PDB and old whitepaper workflow noise.

Runtime evidence:

- `/healthz` returns HTTP 200 with `{"status":"ok","service":"torghut"}`.
- `/trading/status` reports runtime build `v0.568.5-602-gfa3d104cb`, commit
  `fa3d104cb600392d0cc6a91eb6e8d6a08df5b74a`, active revision `torghut-00310`, `enabled=true`, `running=true`,
  mode `live`, and autonomy disabled.
- Live submission remains blocked as intended: `allowed=false`, reason `simple_submit_disabled`, blockers
  `alpha_readiness_not_promotion_eligible` and `simple_submit_disabled`, capital stage `shadow`, and
  `promotion_eligible_total=0`.
- Quant evidence is non-blocking but degraded: `required=false`, `ok=true`, latest metrics count `144`, latest
  metrics at `2026-05-08T13:39:46.497Z`, and `metrics_pipeline_lag_seconds=67`.
- `/trading/health` returns HTTP 503 with status `degraded`; dependencies `postgres`, `clickhouse`, `alpaca`,
  `universe`, and `empirical_jobs` are ok, while `profitability_proof_floor` is `repair_only` and
  `live_submission_gate` is blocked.
- `/trading/consumer-evidence` now exposes `torghut.profit-repair-settlement-ledger.v1` on `torghut-00310`.
  The ledger is `aggregate_state=repair`, `next_safe_action=zero_notional_repair`, with 7 repair lots, 7
  zero-notional lots, 0 routeable candidates, 10 quality-frontier packets, and rollback target
  `live_submit_enabled=false`.
- The capital reentry ledger reports 5 repair cohorts, 5 zero-notional cohorts, 0 routeable candidates, and expected
  unblock value 19.

Value-gate evidence:

- `post_cost_daily_net_pnl`: no live PnL claimed. Runtime remains revenue-inactive by design because live submission
  is disabled and proof floor is repair-only.
- `routeable_candidate_count`: still 0. The release improves repair visibility by making settlement lots and expected
  unblock value explicit.
- `zero_notional_or_stale_evidence_rate`: improved observability; all 7 profit repair lots remain zero-notional and
  list their stale or missing evidence blockers.
- `fill_tca_or_slippage_quality`: repair lots identify route TCA exclusions for AMD, AVGO, INTC, and NVDA and missing
  TCA probes for AMZN, GOOGL, and ORCL.
- `capital_gate_safety`: preserved. Every profit repair lot has `paper_notional_limit=0` and `live_notional_limit=0`;
  submit enablement explicitly rolls back if proof floor is `repair_only` or max notional is zero.

Rollback path:

- Revert #6119 or promote the previous Torghut digest
  `sha256:561bd5d42db9b3c03567f59d475b21df1cd9bbb6a7b50e8155c7375b087d3d77` through the normal GitOps release PR path.
- If the Jangar evidence-router side regresses, revert #6120 or promote the previous known-good Jangar image through
  the normal Jangar release PR path.
- Capital rollback is already enforced at runtime: zero notional, live submit disabled, and profit-repair settlement
  consumption disabled in rollback targets.

The revenue metric advanced is routeable post-cost profit evidence readiness, specifically
`zero_notional_or_stale_evidence_rate` and `fill_tca_or_slippage_quality` observability. The smallest blocker
preventing revenue impact is not deployment health; it is evidence repair: zero routeable candidates, quant stage
coverage degraded, route TCA gaps, schema/rejection-drag debt, alpha readiness not promotion-eligible, and simple
submit disabled.

## Owner update message - 2026-05-08T13:42Z

Rollout gate is green. #6115 and #6117 are merged, Torghut promotion #6119 and Jangar promotion #6120 are merged, and
Argo shows `torghut`, `torghut-options`, and `jangar` `Synced`/`Healthy` at
`74befb03e6df84d62b53f5732e0bcc6b90ef52d8`.

Live, sim, catalog, and enricher workloads are ready on Torghut digest
`sha256:3b77bbd6fc7607d3f660cb2a1f8a4937f72359bff4929121a6086e166795ac98`; `/trading/status` reports commit
`fa3d104cb600392d0cc6a91eb6e8d6a08df5b74a`, active revision `torghut-00310`, enabled live mode, and running.
Trading remains capital-safe rather than revenue-active: routeable candidates are 0, the profit repair ledger has 7
zero-notional repair lots, and live submission is blocked by `simple_submit_disabled` plus alpha readiness.

Next action is evidence repair, not another deployment: clear quant stage coverage, route TCA gaps, schema/rejection
drag debt, and alpha-readiness blockers before any paper or live notional opens.

## Final release refresh - 2026-05-08T10:18Z

This section supersedes the earlier no-go snapshots below.

Final merge and rollout gate is go. PR #5412, `feat(torghut): add profit escrow runtime projections`, was
squash-merged after terminal-green checks at merge commit `7a5c2788f23fc622760ff11dd7c4fd989e3ed64f`. The
large-diff Codex review connector was usage-limited, but the maintainer waiver was recorded on the PR before merge.

The generated deploy PR #6091 was reviewed and manually approved for additive migration
`0030_evidence_epochs.py`, then closed as superseded. Main had already merged newer descendant promotion PR #6093,
`chore(torghut): promote image 8a01e3d2`, at `8d4afcbcdb8b0e74b1cd7c3f731bd9c5d403319d`. Because #6093 includes
#5412 and promotes source commit `8a01e3d20e26be623a3fa2dd234d161a5c78218d`, conflict-resolving #6091 would have
risked rolling Torghut back to the older #5412-only image digest.

The active rollout is #6093:

- Source commit: `8a01e3d20e26be623a3fa2dd234d161a5c78218d`
- Merge commit: `8d4afcbcdb8b0e74b1cd7c3f731bd9c5d403319d`
- Image digest: `sha256:dbd4b1b267f2387aeecf7e3f3f242b8630b7fdddb7f2a69f4c827a7069ae6afa`
- Post-deploy verify: `torghut-post-deploy-verify` run `25549826301`, success at 2026-05-08T10:16:55Z

Argo CD reports `torghut` and `torghut-options` as `Synced` and `Healthy` at revision
`8d4afcbcdb8b0e74b1cd7c3f731bd9c5d403319d`. Live/sim/options workloads are ready on the promoted digest:
`torghut-00306-deployment`, `torghut-sim-00404-deployment`, `torghut-options-catalog`, and
`torghut-options-enricher` all report `1/1` ready. The service account cannot read Knative `ksvc` objects, so the
rollout was verified through Argo Application state, deployments, pods, events, post-deploy CI, and in-cluster HTTP
checks.

Runtime evidence is healthy for service rollout but still capital-safe and revenue-inactive. `/healthz`,
`/trading/status`, and `/trading/revenue-repair` return HTTP 200; `/readyz` returns HTTP 503 because readiness/capital
conditions remain blocked. `/trading/status` reports active revision `torghut-00306`, mode `live`, enabled `true`,
running `true`, kill switch `false`, proof floor `repair_only`, route state `repair_only`, capital state
`zero_notional`, `max_notional=0`, and `simple_lane_orders_submitted_total=0`.

Value-gate evidence after rollout:

- `post_cost_daily_net_pnl`: no live revenue impact claimed; runtime is intentionally `repair_only` with
  `revenue_ready=false`.
- `routeable_candidate_count`: execution TCA shows one routeable symbol; route board has `probing=1`, `blocked=4`,
  `missing=3`, and `capital_eligible_symbol_count=0`.
- `zero_notional_or_stale_evidence_rate`: route board row count `8`, zero-notional row count `8`, and max notional
  remains `0`.
- `fill_tca_or_slippage_quality`: TCA is fresh enough to pass as evidence, but route-universe exclusions remain
  enforced; aggregate average absolute slippage is about `13.82` bps versus the 8 bps guardrail.
- `capital_gate_safety`: live submission is not allowed, capital remains zero-notional, and blockers include
  `alpha_readiness_not_promotion_eligible`, `simple_submit_disabled`, and quant/forecast evidence gaps.

Profit-evidence surfaces are live on `torghut-00306`: profit lease projection has three repair-only leases,
route-proven profit receipt decision is `repair`, renewal bond profit escrow verdict is `repair_only`, and the
consumer evidence receipt is present with empirical jobs `healthy`, forecast registry `degraded`, and TCA `pass`.
The revenue metric advanced is routeable post-cost profit evidence observability and repair prioritization, not live
PnL. The smallest blocker preventing revenue impact is evidence repair: alpha readiness, quant pipeline stage
coverage, route universe/TCA slippage quality, market-context freshness, and simple submit enablement.

Rollback path: revert #6093 or promote the prior known-good Torghut digest
`sha256:fbe830e2803933df61deb7d13bfd26f9a1c640f90b24b20f5fb40909d4256110` through the normal GitOps release PR path.
The additive evidence epoch tables from #5412 can remain unused if the image is rolled back, and capital is already
held at the rollback target of zero notional with live submit disabled.

## Owner update message - 2026-05-08T10:18Z

#5412 is merged and rolled out through the newer descendant Torghut promotion #6093, not the stale #6091 promotion
branch. Argo reports `torghut` and `torghut-options` `Synced`/`Healthy` at
`8d4afcbcdb8b0e74b1cd7c3f731bd9c5d403319d`, post-deploy verify run `25549826301` passed, and live/sim/options
workloads are ready on digest `sha256:dbd4b1b267f2387aeecf7e3f3f242b8630b7fdddb7f2a69f4c827a7069ae6afa`.

Runtime evidence is safe but still repair-only: revenue_ready=false, capital_state=zero_notional, max_notional=0,
TCA routeable symbol count=1, route board zero-notional rows=8/8, expected unblock value=14. Next action is evidence
repair before revenue activation, not another rollout.

## Historical release refresh - 2026-05-08T08:43Z

This section supersedes earlier rollout snapshots in this document.

Final merge gate is no-go for #5412. The PR is open, non-draft, conflict-free, and green on hosted checks at head
`489ef179d7d6b8c5fae0cbbc9f339876db3c32f5`, but it is 8,074 additions and 617 deletions. No Codex review is posted,
no review thread exists, and no maintainer waiver is recorded. The latest `@codex review` request for this head
returned the Codex usage-limit blocker at 2026-05-08T08:11:33Z.

Audit PRs #6066 and #6071 were squash-merged. Torghut promotion PR #6073 was also merged with green checks, and the
repository has advanced through current main `61f2e2e4a6b68787b7fcd1fcbb7a75094cc4cace` after Bilig-only automated
release PRs #6076 and #6077. Argo CD reports Torghut apps as `Synced` and `Healthy` on the promoted Torghut image;
`root` and `symphony-torghut` are also `Synced` and `Healthy` at their latest relevant revisions.

Torghut live and sim workloads are ready on image digest
`sha256:9990cbcc5214e04b541d78009ced9930b3b18d062d4d5a1ff525b43e2560ebba`, runtime build commit
`171fa3f14ae53adf17f3426d13e7fe3a27cb2438`, active revision `torghut-00304`. `/healthz`, `/trading/status`, and
`/trading/consumer-evidence` return HTTP 200. Runtime remains capital-safe: proof floor `repair_only`, route state
`repair_only`, capital state `zero_notional`, `max_notional=0`, and live submission blocked by
`simple_submit_disabled`.

Revenue impact remains blocked rather than realized. The smallest blocker preventing revenue impact is the missing
large-diff Codex review or explicit maintainer waiver for #5412; after that, alpha readiness and live submission gates
must still clear before non-zero notional.

## Owner update message

Merge gate is no-go for #5412. The PR is open, non-draft, conflict-free, and green on hosted checks at
head `489ef179d7d6b8c5fae0cbbc9f339876db3c32f5`, but it is still above the large-diff review threshold
at 8,074 additions and 617 deletions. There is no posted Codex review and no review thread; the latest
`@codex review` request for this head returned the Codex usage-limit blocker at 2026-05-08T08:11:33Z.

The audit PRs for this pass, #6066 and #6071, merged at `f45234fc501469f947ad8c055e50ebfb95e6565f` and
`6a8dcc517167507c391af3ddc3442d38994f6eb5`. Current main then advanced to
`61f2e2e4a6b68787b7fcd1fcbb7a75094cc4cace` through #6073, #6076, and #6077. The Torghut rollout remains healthy:
Argo CD reports Torghut apps as `Synced` and `Healthy`. Live and sim Torghut workloads are ready on image digest
`sha256:9990cbcc5214e04b541d78009ced9930b3b18d062d4d5a1ff525b43e2560ebba`, runtime build commit
`171fa3f14ae53adf17f3426d13e7fe3a27cb2438`, active revision `torghut-00304`.

Trading remains intentionally capital-safe: `/trading/status` reports `floor_state=repair_only`,
`route_state=repair_only`, `capital_state=zero_notional`, `max_notional=0`, and live submission blocked by
`simple_submit_disabled`. The smallest blocker preventing revenue impact is the missing large-diff Codex
review or explicit maintainer waiver for #5412; after that, the runtime still needs alpha-readiness and
live-submission gates to clear before non-zero notional.

## Governing requirements

- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md` keeps deployed
  runtime source of truth in `argocd/applications/torghut/**`, `services/torghut/README.md`, and
  `services/torghut/app/config.py`.
- `docs/torghut/design-system/v6/182-torghut-route-proven-profit-receipts-and-consumer-evidence-canary-2026-05-08.md`
  requires route-proven profit evidence, explicit route repair packets, and paper/live notional held at zero when the
  receipt boundary is not promotion-authoritative.
- `docs/torghut/design-system/v1/architecture-and-context.md` defines GitOps manifests under
  `argocd/applications/torghut/**` as the production deployment source of truth and requires explicit namespace
  checks for workload health.

## Open PR enumeration

- #5412, `feat(torghut): add profit escrow runtime projections`
  - Selected as the only open Torghut runtime PR in this inventory.
  - Merge gate: no-go. Checks are green and merge state is clean, but the large-diff Codex review has not posted.
- #6060, `docs(jangar): refresh control plane release gate`
  - Not selected: Jangar verifier documentation scope, not Torghut runtime scope.
- #5889, `feat(jangar): add repair warrant exchange`
  - Not selected: Jangar control-plane scope, not Torghut runtime scope.
- #5767, `chore(release/c3ba60b): automated release PR`
  - Not selected: older automated release PR outside the Torghut quant runtime gate.
- #5316, `chore(release/735ddbc): automated release PR`
  - Not selected: older automated release PR outside the Torghut quant runtime gate.

## PRs touched

- #5412
  - Rechecked mergeability, hosted checks, review state, comments, review threads, and changed-line count.
  - Latest reviewed head: `489ef179d7d6b8c5fae0cbbc9f339876db3c32f5`.
  - Latest Codex review request:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4404817379
  - Latest connector blocker:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4404818477
  - Kept open and unmerged.
- Current main rollout
  - Verified current main `61f2e2e4a6b68787b7fcd1fcbb7a75094cc4cace` in Argo CD and live Torghut workloads.
  - No direct production mutation was made from the local shell.

## Comments and conflicts resolved

- #5412 reports `mergeStateStatus=CLEAN` and `mergeable=MERGEABLE`.
- #5412 has zero review threads and no posted GitHub reviews.
- #5412 is comment-clean except for the unresolved policy blocker: every latest Codex review request returns the
  usage-limit response instead of a review.
- No merge conflict required local resolution in this pass.
- No service code was changed in this pass.

## Merge outcomes

- #5412: not merged. Merge is blocked by the mandatory large-diff Codex review gate.
- No selected Torghut code PR was squash-merged during this pass.
- Current main rollout was verified only; it was not mutated from this workspace.

## Validation

- PASS: memory retrieval completed with prior Torghut release-gate context.
- PASS: NATS context soak with `/usr/local/bin/codex-nats-soak` wrote `.codex-nats-context.json`; it fetched 25
  general-channel messages and filtered 0 relevant messages.
- PASS: open PR inventory from
  `gh pr list -R proompteng/lab --state open --limit 100 --json number,title,headRefName,baseRefName,...`.
- PASS: `gh pr view 5412 -R proompteng/lab --json ...` reports head
  `489ef179d7d6b8c5fae0cbbc9f339876db3c32f5`, `CLEAN`, `MERGEABLE`, 8,074 additions, and 617 deletions.
- PASS: `gh pr checks 5412 -R proompteng/lab --watch --interval 20` reports all non-skipped checks passing,
  including `Bytecode + pytest + coverage`, `Pyright`, `Quality signals (complexity + security)`,
  `agents-ci / integration` after 14m46s, `agents-ci / validate`, `jangar-ci / lint-and-typecheck / run`,
  `check_changed_files`, semantic commits, and semantic PR title.
- PASS: `gh api repos/proompteng/lab/pulls/5412/reviews --paginate` returned no reviews.
- PASS: `gh api graphql ... reviewThreads(first:100)` returned `totalCount=0`.
- BLOCKED: the latest `@codex review` request returned the Codex usage-limit response instead of posting a review.
- PASS: `kubectl get applications.argoproj.io -n argocd torghut torghut-options symphony-torghut ...` reports all
  three apps `Synced` and `Healthy`; final revision evidence is recorded in this run's handoff artifact because main
  continued advancing while this audit branch was rebased.
- PASS: `kubectl get deploy -n torghut ...` reports live, sim, options, websocket, and TA deployments ready and
  available.
- PASS: `kubectl get events -n torghut --sort-by=.lastTimestamp` showed only expected rollout events and transient
  readiness warnings on old scaled-down revisions; new revisions became ready and backfill jobs completed.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/healthz` returns HTTP 200 with
  `{"status":"ok","service":"torghut"}`.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq ...` reports the runtime build,
  proof floor, live-submission gate, TCA route evidence, and capital state.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq ...` returns HTTP 200
  with schema `torghut.consumer-evidence-status.v1`, fresh empirical jobs, and candidate
  `chip-paper-microbar-composite@execution-proof`.
- LIMITATION: this service account cannot read Knative `services.serving.knative.dev` or `revisions.serving.knative.dev`;
  rollout verification used Argo CD Application state, Deployments, Pods, events, and in-cluster HTTP service access.

## Deployment evidence

- No new rollout was triggered from #5412 because no merge occurred.
- Audit PR #6066 merge revision: `f45234fc501469f947ad8c055e50ebfb95e6565f`.
- Current main revision: `61f2e2e4a6b68787b7fcd1fcbb7a75094cc4cace`.
- Current main subject: `chore(release/4afde74): automated release PR (#6077)`.
- Current main changes after #6066 include #6071, `docs(torghut): refresh quant release hold`; #6073,
  `chore(torghut): promote image 171fa3f1`; #6076, `chore(release/b467628): automated release PR`; and #6077,
  `chore(release/4afde74): automated release PR`. PR #6073 checks are green and the promoted image is live in
  cluster; #6076 and #6077 are Bilig-only release changes.
- Torghut GitOps image digest in current manifests:
  `sha256:9990cbcc5214e04b541d78009ced9930b3b18d062d4d5a1ff525b43e2560ebba`.
- Runtime build: `v0.568.5-556-g171fa3f14`.
- Runtime build commit: `171fa3f14ae53adf17f3426d13e7fe3a27cb2438`.
- Active revision from `/trading/status`: `torghut-00304`.
- Argo state:
  - `torghut`: `Synced` / `Healthy`
  - `torghut-options`: `Synced` / `Healthy`
  - `symphony-torghut`: `Synced` / `Healthy`
- Workload readiness:
  - `torghut-00304-deployment`: `1/1` ready, available, and updated
  - `torghut-sim-00402-deployment`: `1/1` ready, available, and updated
  - `torghut-options-catalog`: `1/1` ready, available, and updated
  - `torghut-options-enricher`: `1/1` ready, available, and updated
  - `torghut-ws`, `torghut-ws-options`, `torghut-ta`, and `torghut-ta-sim`: `1/1` ready and available

## Runtime and value-gate evidence

- `post_cost_daily_net_pnl`: no positive live revenue impact can be claimed from this pass. Current runtime remains
  zero-notional; #5412 is the smallest unmerged blocker for additional profit-evidence projection.
- `routeable_candidate_count`: current proof-floor execution TCA dimension reports one routeable symbol candidate and
  the consumer-evidence route reports candidate `chip-paper-microbar-composite@execution-proof`.
- `zero_notional_or_stale_evidence_rate`: capital is held at `zero_notional`, `max_notional=0`, empirical evidence is
  healthy, and quant evidence is informational/degraded with ingestion lag.
- `fill_tca_or_slippage_quality`: execution TCA reports 7,334 orders, 7,245 filled executions, average absolute
  slippage `13.8203637593029676` bps versus the 8 bps guardrail, and route-universe exclusions enforced.
- `capital_gate_safety`: live submission is not allowed; blockers are `simple_submit_disabled` and
  `alpha_readiness_not_promotion_eligible`.

## Risk

- #5412 remains the main Torghut runtime blocker. Its checks are green, but the required large-diff Codex review is
  not posted.
- The Codex review blocker is outside the local release engineer's control: the connector reports usage limits.
- Runtime trading remains safe but revenue-inactive: proof floor `repair_only`, capital state `zero_notional`, and
  live submission disabled.
- Quant ingestion remains degraded, and alpha readiness is not promotion-eligible.

## Rollback path

- If the current `171fa3f14` rollout becomes unhealthy, open a rollback PR against current `main` that restores the
  previous healthy Torghut digest, then let release automation and Argo CD reconcile. Do not mutate production
  directly from a local shell.
- If #5412 is later merged and regresses runtime health, revert the squash merge through a PR and allow release
  automation plus GitOps reconciliation to promote the reverted image.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false`, live submission blocked, and `capital_state=zero_notional` until proof
  floor, alpha readiness, quant evidence, and review gates are all clear.

Rollback triggers:

- Any of `torghut`, `torghut-options`, or `symphony-torghut` becomes Degraded or stuck OutOfSync.
- Live/sim/options/websocket/TA workloads lose readiness after the startup window.
- `/healthz`, `/trading/status`, or `/trading/consumer-evidence` regresses from HTTP 200.
- Proof floor advances capital away from zero before the documented gates clear.

## Next action

Restore Codex review capacity or record an explicit maintainer waiver for #5412. Then rerun #5412 hosted checks,
resolve any review findings, squash-merge only if all checks are green, and verify the resulting release PR plus Argo
CD rollout before declaring the Torghut quant PR production-ready.
