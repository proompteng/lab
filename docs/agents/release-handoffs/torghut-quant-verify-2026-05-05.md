# Torghut Quant Release Verification

Timestamp: 2026-05-05T17:19:23Z
Repository: `proompteng/lab`
Base: `main`
Release branch: `codex/swarm-torghut-quant-verify`
Audit PR: #5496

## Gate Decision

Go for the selected small Torghut release and safety PRs that passed checks. No-go remains in place for declaring the
post-#5510 rollout fully healthy, for live order submission, and for the large implementation PR.

The high-impact Torghut image promotion #5510 was ready to merge and was squash-merged after all required checks were
green. GitOps then reconciled the promoted image into the cluster and the primary workloads are Running and ready. The
release gate remains blocked at the application-health layer because live Torghut readiness is degraded on the empirical
control-plane quorum, and the options catalog service still returns readiness 503.

PR outcomes:

- #5494, `chore(torghut): promote image 2ea968af`, was clean, comment-clean, and green across Torghut CI, Argo lint,
  kubeconform, semantic title, and semantic commit checks. It was squash-merged at 2026-05-05T16:12:33Z with merge
  commit `2dbe57a9872dac681d6f8cdce021996243f70197`.
- #5503, `fix(torghut): clean argo rollout drift`, was a small follow-up cleanup for drift after #5494. It updated the
  options TA restart nonce, removed a blank DSPy artifact hash from the sim Knative service, and moved the whitepapers
  bootstrap job from `Skip` to `PostSync` hook semantics. It was merged at 2026-05-05T16:36:29Z with merge commit
  `b653bd4fd6faeb39ab78a1eea4d2b6f2ed299f4a`.
- #5507, `fix(torghut): narrow paper lane to executable chip core`, passed every visible required check and had no
  comments or review threads. It was merged at 2026-05-05T16:48:21Z with merge commit
  `d73020e67ff5409786f2c1c9984d03575c648088`.
- #5510, `chore(torghut): promote image d73020e6`, was clean, comment-clean, and green across `torghut-ci`,
  `argo-lint`, `kubeconform`, semantic title, semantic commit checks, and deploy enable checks. I squash-merged it at
  2026-05-05T16:59:52Z with merge commit `de82183cbb55a576e8750f31a327cffb45db0004`.
- #5412, `feat(torghut): add evidence epochs and shared live gate`, remains open and no-go. It is mergeable and
  CI-green, but it changes more than 1,000 lines, so the large-diff Codex review gate applies. The Codex review request
  returned a `chatgpt-codex-connector` usage-limit response instead of a posted review. I did not merge it without a
  posted Codex review and resolved threads, or an explicit maintainer waiver.
- #5496, `docs(torghut): record quant verify release gate`, remains the audit PR for this release verification. It was
  rebased onto current `origin/main` after #5510 and the later Jangar main merge, then updated with the final merge and
  rollout evidence.
- #5458, `chore(torghut): promote image 02ffd49f`, was conflict-blocked and superseded by newer Torghut images. It was
  closed as unsafe to repair because merging it would roll production backward.
- #5467, `chore(torghut): promote image 0c28a908`, was conflict-blocked and superseded by newer Torghut images. It was
  closed as unsafe to repair because merging it would roll production backward.

## Comments And Conflicts

- #5510 had no blocking comments, no review threads, and `mergeStateStatus=CLEAN` before merge.
- #5412 progress stayed anchored with the `<!-- codex:progress -->` marker, and the large-diff review request plus
  connector usage-limit response remain visible on the PR.
- #5412 progress comment:
  https://github.com/proompteng/lab/pull/5412#issuecomment-4378206627.
- #5458 and #5467 were closed with superseded-release comments on their PR timelines.
- #5496 progress comment was updated through `services/jangar/scripts/codex/codex-progress-comment.ts`:
  https://github.com/proompteng/lab/pull/5496#issuecomment-4380989574.
- The audit branch was clean before update and was rebased onto `origin/main` to keep the PR based on the current base
  branch.

## Rollout Evidence

Direct Argo CD Application CR reads were blocked by Kubernetes RBAC for
`system:serviceaccount:agents:agents-sa`, but Argo application-controller logs were readable and provided sync evidence.
The smallest unblocker for direct Application inspection remains read-only `get`/`list` access to
`applications.argoproj.io` in namespace `argocd`, or an Argo CD credential with equivalent read access.

GitOps and sync evidence:

- #5507 put the strategy and websocket fallbacks into the narrow paper-lane safety posture: the cluster
  `torghut-ws-config` ConfigMap had `SYMBOLS=NVDA,AMD,INTC`, the cluster `torghut-strategy-config` ConfigMap marked the
  first strategy as `intraday_tsmom_v1@paper` with `universe_symbols: ["NVDA", "AMD", "INTC"]`, and the live
  `torghut-00215` pod had `TRADING_SIMPLE_SUBMIT_ENABLED=false`.
- `origin/main` now contains #5510 at merge commit `de82183cbb55a576e8750f31a327cffb45db0004`; current observed main
  was `e48d29c997d8c52d1ea98c3fb08a8ecf954e66ae`, which includes #5510.
- `origin/main` manifest `argocd/applications/torghut/knative-service.yaml` points at
  `registry.ide-newton.ts.net/lab/torghut@sha256:5b1685a25cd2d708373d928b095a641b0fe65d0887820f70f32f4e6147bd9bb0`.
- The manifest reports `TORGHUT_VERSION=v0.568.5-9-gd73020e67` and
  `TORGHUT_COMMIT=d73020e67ff5409786f2c1c9984d03575c648088`.
- Argo logs showed automated sync to current main `e48d29c99`, PreSync `torghut-db-migrations`, PostSync
  backfill/bootstrap hooks, and successful sync completion at 2026-05-05T17:07:15Z. Follow-up reconciliations logged
  `Skipping auto-sync: application status is Synced`.

Workload readiness after #5510:

- Before #5510, #5507 had reconciled live `torghut-00215` and sim `torghut-sim-00295` as `2/2 Running` with zero
  restarts, with `torghut-ta`, `torghut-ta-sim`, `torghut-options-ta`, and their taskmanager pods Running and ready.
- Active live pod `torghut-00216-deployment-754d5b75bc-qh9lw` was `2/2 Running` on image digest
  `sha256:5b1685a25cd2d708373d928b095a641b0fe65d0887820f70f32f4e6147bd9bb0` with zero restarts.
- Active sim pod `torghut-sim-00296-deployment-5568dd76df-td2jb` was `2/2 Running` on the same digest with zero
  restarts.
- `torghut-options-catalog-795f94c4cb-9cbzp` and `torghut-options-enricher-5d8dd5fd97-dtj2l` were Running and ready at
  the pod/container layer on the same digest with zero restarts.
- `torghut-ta`, `torghut-ta-sim`, and their taskmanager pods were Running and ready. REST overview checks on port 8081
  returned HTTP 200 with one running Flink job and four taskmanagers for both live and sim TA.

Endpoint evidence:

- Live `/healthz`: HTTP 200.
- Live `/trading/status`: HTTP 200, reporting version `v0.568.5-9-gd73020e67`, commit
  `d73020e67ff5409786f2c1c9984d03575c648088`, and active revision `torghut-00216`.
- Sim `/readyz`: HTTP 200.
- Options enricher `/healthz` and `/readyz`: HTTP 200 with a fresh success timestamp.
- Live `/readyz`: HTTP 503 with scheduler, Postgres, ClickHouse, Alpaca, database, and universe checks OK, but overall
  status `degraded`.
- Live `/trading/health`: HTTP 503 with dependency quorum `decision=block` and reason `empirical_jobs_degraded`. Live
  submission remains blocked by `simple_submit_disabled`, which is expected for the shadow/no-live-submit posture.
- Jangar control-plane status endpoint returned HTTP 200, but `execution_trust.status=degraded` because discover, plan,
  and verify stages were stale. Its dependency quorum also reported `decision=block` with reason
  `empirical_jobs_degraded`, matching the Torghut live health failure.
- Options catalog `/healthz`: HTTP 200, but `/readyz`: HTTP 503 with `ready=false` and `last_success_ts=null`. Logs show
  repeated `/v1/options/hot-set` HTTP 200 responses but no successful catalog readiness cycle yet.

Event notes:

- Expected transient rollout warnings appeared while new revisions and hooks scheduled: startup/readiness probe failures,
  temporary hook scheduling pressure, and old-revision shutdown readiness failures.
- Persistent residual warnings observed during final inspection were `MultiplePodDisruptionBudgets` for ClickHouse pods,
  a Flink status external-modification warning for `torghut-ta`, and scheduling pressure warnings for hook/options pods.
- `torghut-ws` and `torghut-ws-options` were Running and ready during final inspection, but had liveness restarts before
  this #5510 rollout.

## Risk And Rollback

Residual risks:

- Live order submission is intentionally blocked after #5507. Treat `simple_submit_disabled` as the current trading
  gate: the cluster rollout is applied, but live trading remains no-go until executable proof exists and a follow-up PR
  re-enables submit.
- The cluster has reconciled the #5510 image, but production health is not fully green because live Torghut readiness and
  trading health remain 503 on the empirical/Jangar dependency quorum.
- Options catalog readiness is a second application-health blocker: pod readiness and `/healthz` are green, but service
  `/readyz` is 503 with no successful catalog cycle timestamp.
- Jangar's dynamic equity universe endpoint previously returned a wider symbol set than the deployed static fallback,
  strategy catalog, and websocket fallback. The final #5510 live readiness payload reported the Jangar universe fresh
  with three symbols, but this should remain auditable before claiming durable runtime universe closure.
- #5412 remains unmerged because Codex review capacity is exhausted. It should stay blocked until a Codex review posts
  and all resulting threads resolve, or until a maintainer explicitly waives the gate.
- Direct Argo Application CR reads are blocked for `system:serviceaccount:agents:agents-sa`; use a credential with
  Application read access for direct sync inspection.

Rollback path:

- For #5507, revert merge commit `d73020e67ff5409786f2c1c9984d03575c648088` if the submit-disable health behavior or
  chip-core narrowing causes unacceptable production impact. Reverting will re-enable the prior live submit posture, so
  require explicit maintainer approval before using that rollback.
- For #5503, revert merge commit `b653bd4fd6faeb39ab78a1eea4d2b6f2ed299f4a` if the hook or options TA drift cleanup
  regresses reconciliation.
- For #5494, revert merge commit `2dbe57a9872dac681d6f8cdce021996243f70197` or open a new GitOps promotion PR to the
  previous known-good Torghut image, then let Argo CD reconcile.
- For #5510, revert merge commit `de82183cbb55a576e8750f31a327cffb45db0004` or open a new GitOps promotion PR back to
  the previous known-good Torghut image digest
  `sha256:6ee3ec45802d336b0e6626e942d380a9bb47bb375f0901012d80e653f76c127b`, then let Argo CD reconcile.
- Because the live empirical/Jangar degradation is tied to stale control-plane evidence, not a pod crash or schema
  failure, rollback should be reserved for image-specific regression evidence such as new crashes, new error rates, or a
  broader endpoint regression. Restoring Jangar evidence freshness is the first targeted remediation for the live health
  blocker.
- For options catalog readiness, inspect the catalog worker loop and upstream data/source dependencies. If readiness does
  not recover or options traffic depends on it, roll back the #5510 image through GitOps.

## Owner Update Message

Rollout gate is blocked at application health, not at GitOps. I squash-merged #5510 after all required checks were green,
and Argo synced current main `e48d29c99`, including #5510, into Torghut at 2026-05-05T17:07:15Z. Live and sim moved to
`torghut-00216` and `torghut-sim-00296` on digest `5b1685a25` with zero restarts; sim `/readyz`, live `/healthz`, live
`/trading/status`, TA, TA-sim, and options-enricher are green. I am not declaring the rollout fully healthy because live
`/readyz` and `/trading/health` are 503 from `empirical_jobs_degraded` with Jangar execution trust stale, and options
catalog `/readyz` is 503 with no successful catalog cycle yet. Rollback is a revert of #5510 merge commit `de82183cb` or
a GitOps promotion back to digest `6ee3ec45`; first remediation should restore Jangar evidence freshness and options
catalog readiness, then re-probe before any further Torghut PR merge.

## Next Action

Restore Jangar control-plane evidence freshness and options catalog readiness, then re-run live `/readyz`,
`/trading/health`, options catalog `/readyz`, pod readiness, and recent warning events. Keep #5412 blocked until Codex
review capacity returns or a maintainer explicitly waives the large-diff review gate.
