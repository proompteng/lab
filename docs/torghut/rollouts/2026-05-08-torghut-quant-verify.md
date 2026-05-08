# Torghut quant verifier release gate - 2026-05-08

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-08T01:59:17Z

## Owner update message

Torghut rollout state is green for the latest merged production commit and no-go for the remaining
open Torghut runtime PR.

#6002, `fix(torghut): gate route packets on jangar continuity`, squash-merged at
`7d88cb2a34d47c2d857c8c0824bbaa5d8cdcdcf4` after PR checks passed. #6005,
`chore(torghut): promote image 7d88cb2a`, promoted that source commit through GitOps at
`227aaa46b75071da8f237f0f3f99ba75e9e27187` with image digest
`sha256:a5f1bfde242b80a1c18d7776859dcb1b56d69c5ec5d742bb59b5244ec54c87a2`.

Argo CD reports `torghut` `Synced` / `Healthy` at
`227aaa46b75071da8f237f0f3f99ba75e9e27187`. The current live and simulation Knative deployments,
`torghut-00292` and `torghut-sim-00391`, are rolled out and `2/2` ready. The options catalog and
options enricher deployments are rolled out and ready. Mainline `torghut-ci`, `argo-lint`,
`kubeconform`, and `torghut-post-deploy-verify` passed on the promotion commit.

#5412, `feat(torghut): add profit escrow runtime projections`, remains no-go. It is clean,
mergeable, and green on hosted checks at head `d416dcfc0f87bf97fbee0291a99871ff11a0857e`, with zero
review threads, but the current diff is 7,099 additions and 498 deletions. That exceeds the mandatory
large-diff Codex review threshold. The latest review request returned the Codex code-review
usage-limit blocker instead of a posted review. Smallest unblocker: restore Codex review capacity or
record an explicit maintainer waiver, then refresh against `main`, resolve any review threads, rerun
required checks, and only then squash-merge.

Runtime trading promotion remains intentionally closed, not rolled back: the post-deploy revenue
repair artifact reports `business_state=repair_only`, `revenue_ready=false`,
`live_submission_reason=simple_submit_disabled`, `capital_state=zero_notional`, and
`max_notional=0`.

## Open PR enumeration

- #5412, `feat(torghut): add profit escrow runtime projections`
  - Selected as the only open Torghut runtime PR.
  - Held no-go on the mandatory large-diff Codex review gate.
- #5889, `feat(jangar): add repair warrant exchange`
  - Open Jangar control-plane PR, not selected for the Torghut release lane.
  - It also remains over the large-diff review threshold without a posted Codex review.
- #5767 and #5316, automated release PRs
  - Older release automation PRs, not selected because they are not the unblock-first path for the
    current Torghut runtime gate.

## PRs touched

- #5412
  - Rechecked open PR state, mergeability, hosted checks, review threads, and latest Codex review
    blocker.
  - Updated the anchored `<!-- codex:progress -->` comment with current no-go evidence.
  - Did not merge because the large-diff review gate is unmet.
- #6002
  - Verified after merge as the source commit behind the current Torghut promotion.
  - PR checks passed before merge, including Torghut Pyright, quality signals, bytecode + pytest +
    coverage, changed-files, Semantic PR title, and Semantic commit messages.
- #6005
  - Verified as the GitOps image promotion for #6002.
  - Confirmed mainline CI, post-deploy verifier, Argo sync, workload readiness, image digest, and
    event posture.

## Comments and conflicts

- #5412 has `mergeStateStatus=CLEAN`, `mergeable=MERGEABLE`, zero review threads, zero posted
  reviews, and no visible blocking review comments.
- #5412 remains blocked by policy because the required large-diff Codex review has not posted.
- Latest #5412 progress evidence before this refresh cited the current head
  `d416dcfc0f87bf97fbee0291a99871ff11a0857e` and connector usage-limit blocker.
- No direct production mutations were made from the local shell. Production promotion occurred
  through PR merge, release automation, and Argo CD reconciliation.
- Live release updates were published through `/usr/local/bin/codex-nats-publish --publish-general`.

## Validation

- PASS: NATS context soak was read before action with `/usr/local/bin/codex-nats-soak`; a broader
  general-channel read was also taken for recent teammate state.
- PASS: `gh pr list --repo proompteng/lab --state open --limit 100 --json ...`; open PRs were
  enumerated and #5412 was selected as the only open Torghut runtime PR.
- PASS: `gh pr checks 5412 --repo proompteng/lab`; hosted checks are pass or intentionally skipped:
  - `torghut-ci / Bytecode + pytest + coverage`
  - `torghut-ci / Pyright`
  - `torghut-ci / Quality signals (complexity + security)`
  - `CI / check_changed_files`
  - `Semantic Commits / Lint commit messages`
  - `Semantic Pull Request / Validate PR title`
- PASS: GitHub GraphQL review-thread query for #5412 returned `totalCount=0`; latest reviews are
  empty.
- BLOCKED: #5412 changed lines are 7,597 total, above the 1,000-line Codex review gate; no Codex
  review has posted.
- PASS: #6002 PR checks passed before merge, with one superseded semantic-commit run cancelled and
  a later semantic-commit run passing.
- PASS: #6005 PR checks passed before merge: argo-lint, kubeconform, Torghut Pyright, Torghut
  quality signals, Torghut bytecode + pytest + coverage, Semantic PR title, Semantic commits, and
  deploy-automerge enable.
- PASS: `gh run view 25532144730 --repo proompteng/lab --json ...`; mainline `torghut-ci` passed on
  `227aaa46b75071da8f237f0f3f99ba75e9e27187`.
- PASS: `gh run view 25532144727 --repo proompteng/lab --json ...`; `torghut-post-deploy-verify`
  passed on `227aaa46b75071da8f237f0f3f99ba75e9e27187`.
- PASS: `gh run list --repo proompteng/lab --branch main --limit 10 --json ...`; latest Torghut
  `argo-lint`, `kubeconform`, `torghut-ci`, and `torghut-post-deploy-verify` runs are green.
- PASS: `kubectl get application -n argocd torghut -o jsonpath=...`; Argo CD reports `Synced`,
  `Healthy`, revision `227aaa46b75071da8f237f0f3f99ba75e9e27187`, operation `Succeeded`, and
  `successfully synced (no more tasks)`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-00292-deployment --timeout=120s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-sim-00391-deployment --timeout=120s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-options-catalog --timeout=120s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-options-enricher --timeout=120s`.
- PASS: `kubectl get pods -n torghut -o custom-columns=...`; current live, sim, options catalog,
  options enricher, databases, ClickHouse, Flink, exporters, and web-socket pods are Running and
  ready.
- LIMITATION: `kubectl get ksvc -n torghut` is forbidden for the runner service account. Knative
  readiness was verified through the underlying deployment rollout, pods, Argo health, and
  post-deploy verifier.

## Deployment evidence

GitOps state:

- `torghut`: `Synced` / `Healthy`
- Revision: `227aaa46b75071da8f237f0f3f99ba75e9e27187`
- Operation: `Succeeded`
- Finished at: 2026-05-08T01:55:39Z
- Message: `successfully synced (no more tasks)`

Image evidence:

- Source commit: `7d88cb2a34d47c2d857c8c0824bbaa5d8cdcdcf4`
- Promotion commit: `227aaa46b75071da8f237f0f3f99ba75e9e27187`
- Torghut image digest:
  `sha256:a5f1bfde242b80a1c18d7776859dcb1b56d69c5ec5d742bb59b5244ec54c87a2`
- Current `torghut-00292`, `torghut-sim-00391`, `torghut-options-catalog`, and
  `torghut-options-enricher` deployments use that digest.

Workload readiness:

- `torghut-00292-deployment-68579d98b7-h5ctj`: `2/2` ready, Running, zero restarts.
- `torghut-sim-00391-deployment-74c5c47749-lcmjq`: `2/2` ready, Running, zero restarts.
- `torghut-options-catalog-6c68597999-hgqh9`: ready, Running, zero restarts.
- `torghut-options-enricher-586c7cc756-nmx4j`: ready, Running, zero restarts.
- `torghut-db-1`, ClickHouse pods, keeper, TA Flink deployments, exporters, and web-socket pods are
  Running and ready.

Post-deploy verifier:

- `torghut-post-deploy-verify` run `25532144727` passed.
- Artifact `torghut-revenue-repair-25532144727-1` was uploaded.
- `torghut-ws /readyz`: `ready=true`, `alpaca_ws=true`, `kafka=true`, `trade_updates=true`.
- Torghut `/readyz`: degraded for safety gates, not rollout failure. Core dependencies report
  `postgres=true`, `clickhouse=true`, `alpaca=true`, and `universe=true`.
- Revenue repair digest: `business_state=repair_only`, `revenue_ready=false`,
  `live_submission_allowed=false`, `live_submission_reason=simple_submit_disabled`,
  `proof_floor_state=repair_only`, `capital_state=zero_notional`, `max_notional=0`.
- Runtime blockers in the digest: `alpha_readiness_not_promotion_eligible`,
  `execution_tca_route_universe_incomplete`, `simple_submit_disabled`, and
  `quant_pipeline_degraded`.

Event review:

- Recent rollout events show normal creation, image pull, revision-ready, ingress update, hook-job
  completion, and old-revision scale-down events.
- Transient startup/readiness probe warnings occurred during rollout for live, sim, options catalog,
  and options enricher pods; all active replacements are now ready.
- Recurring ClickHouse `MultiplePodDisruptionBudgets` and `torghut-keeper` `NoPods` events remain
  cluster hygiene debt, not a rollback trigger for #6002/#6005.
- `torghut-whitepaper-autoresearch-profit-target-8r6w6` is an older failed pod and is unrelated
  residual noise, not part of the current rollout.

## Risk

- #5412 is the main unmerged Torghut runtime risk. It changes profit-escrow runtime projections and
  must not merge until the large-diff review gate is satisfied.
- Codex code-review capacity is the blocker for #5412. The connector is returning the usage-limit
  response rather than a review.
- Runtime trading promotion is still deliberately closed by safety gates. That is the expected
  posture for this rollout, but it means production is in `repair_only` / zero-notional mode.
- Route-universe and execution-TCA evidence remain incomplete for live capital promotion.
- The runner service account cannot list Knative Services in the `torghut` namespace, so rollout
  verification used Argo, Deployments, Pods, events, and the post-deploy verifier.

## Rollback path

- Immediate GitOps rollback for #6005: open a PR reverting
  `227aaa46b75071da8f237f0f3f99ba75e9e27187`, or restore the previous healthy Torghut image digest
  in the Torghut and Torghut options manifests, then let Argo CD reconcile.
- Source rollback for #6002: revert `7d88cb2a34d47c2d857c8c0824bbaa5d8cdcdcf4`, let
  `torghut-build-push` build the revert, and let `torghut-release` open the normal GitOps promotion
  PR.
- Runtime safety rollback: keep live submission disabled and `capital_state=zero_notional` until the
  route universe, execution TCA, alpha readiness, and quant pipeline evidence clear.
- #5412 needs no runtime rollback because it was not merged.

Rollback triggers for #6002/#6005:

- `torghut` becomes Degraded or stuck OutOfSync on the promoted revision.
- Mainline Torghut checks fail on the current promotion commit.
- Active live/sim/options workloads lose readiness or restart repeatedly.
- Post-deploy revenue repair or web-socket readiness regresses.
- Runtime blockers expand beyond the documented safety-gate posture into core dependency failure
  such as Postgres, ClickHouse, Alpaca, or universe resolution failure.

## Next action

Keep #5412 open and blocked. The next release captain should not merge it until Codex review capacity
is restored or a maintainer explicitly waives the large-diff gate. After that, refresh against
current `main`, resolve all review threads, rerun required checks, squash-merge only with all required
checks green, and repeat GitOps, workload, post-deploy, and event verification.
