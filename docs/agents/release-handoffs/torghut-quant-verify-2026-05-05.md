# Torghut Quant Release Verification

Timestamp: 2026-05-05T17:56:28Z
Repository: `proompteng/lab`
Base: `main`
Release branch: `codex/swarm-torghut-quant-verify`
Audit PRs: #5496 plus follow-up #5523 on the same release branch

## Gate Decision

Go for the selected small Torghut image promotion #5514 after all required checks passed. No-go remains in place for
declaring the post-merge application rollout fully healthy, for live order submission, and for the large implementation
PR #5412.

#5514, `chore(torghut): promote image 59511b6b`, was clean, comment-clean, and green before merge. I squash-merged it at
2026-05-05T17:31:56Z with merge commit `76709ed093bcff552d3a73c14d3563883ad5e81c`. Argo CD reconciled the Torghut and
Torghut options applications to main revision `be72b6213be7cb00d92b76364147519a1cbaf3eb`, which includes #5514 and the
promoted Torghut image digest `sha256:f183391e56cf5b52ee1d1cf73fbade982d46f357633b7942ebf674e6e8ef4f0a`.

The rollout is not a production-health go. GitOps sync completed and Kubernetes workload readiness is green for the
new live, sim, options catalog, and options enricher pods, but application readiness remains blocked: live Torghut
reports 503 because live submission is intentionally disabled, and the options catalog `/readyz` endpoint still reports
503 with `ready=false` and `last_success_ts=null`.

## PR Outcomes

- #5494, `chore(torghut): promote image 2ea968af`, was squash-merged at 2026-05-05T16:12:33Z with merge commit
  `2dbe57a9872dac681d6f8cdce021996243f70197`.
- #5503, `fix(torghut): clean argo rollout drift`, was squash-merged at 2026-05-05T16:36:29Z with merge commit
  `b653bd4fd6faeb39ab78a1eea4d2b6f2ed299f4a`.
- #5507, `fix(torghut): narrow paper lane to executable chip core`, was squash-merged at 2026-05-05T16:48:21Z with
  merge commit `d73020e67ff5409786f2c1c9984d03575c648088`.
- #5510, `chore(torghut): promote image d73020e6`, was squash-merged at 2026-05-05T16:59:52Z with merge commit
  `de82183cbb55a576e8750f31a327cffb45db0004`.
- #5514, `chore(torghut): promote image 59511b6b`, was squash-merged at 2026-05-05T17:31:56Z with merge commit
  `76709ed093bcff552d3a73c14d3563883ad5e81c`.
- #5412, `feat(torghut): add evidence epochs and shared live gate`, remains open and no-go. It is CI-green but changes
  3,165 total lines, so the large-diff Codex review gate applies. The requested Codex review returned a
  `chatgpt-codex-connector` usage-limit response instead of a posted review. I did not merge it without a posted Codex
  review and resolved threads, or an explicit maintainer waiver.
- #5458 and #5467 were previously closed as superseded image promotions because repairing either PR would have rolled
  production backward.
- #5523, `docs(torghut): update quant rollout verification`, is the follow-up audit PR on
  `codex/swarm-torghut-quant-verify`. It records the #5514 merge decision, refreshed rollout evidence, residual risk,
  and rollback path.

## Comments And Conflicts

- #5514 had no blocking comments, no review threads, and required checks were green before merge.
- #5412 progress stayed anchored with the `<!-- codex:progress -->` marker:
  https://github.com/proompteng/lab/pull/5412#issuecomment-4378206627.
- #5412 has no posted Codex review and no review threads to resolve; the blocker is the missing large-diff review, not a
  failing check.
- This follow-up audit branch was merged with current `origin/main` before updating the handoff, resolving the prior
  add/add conflict in this document by preserving current main evidence and appending #5514 rollout evidence.

## Rollout Evidence

Direct Argo CD Application CR reads are blocked by Kubernetes RBAC for `system:serviceaccount:agents:agents-sa`, but
Argo application-controller logs are readable and provided sync evidence. The smallest unblocker for direct Application
inspection remains read-only `get`/`list` access to `applications.argoproj.io` in namespace `argocd`, or an Argo CD
credential with equivalent read access.

GitOps and sync evidence:

- Argo logs showed `torghut` initiated automated sync to `be72b6213be7cb00d92b76364147519a1cbaf3eb` at
  2026-05-05T17:35:04Z and completed successfully at 2026-05-05T17:38:43Z.
- Argo logs showed `torghut-options` initiated automated sync to the same revision at 2026-05-05T17:35:14Z and
  completed successfully at 2026-05-05T17:35:15Z.
- Follow-up Argo reconciliations logged `Skipping auto-sync: application status is Synced` for both applications.
- `origin/main` contains #5514 at merge commit `76709ed093bcff552d3a73c14d3563883ad5e81c`; later main revisions were
  docs/Jangar changes and did not change the promoted Torghut digest.

Workload readiness after #5514:

- Live pod `torghut-00217-deployment-cfd7f798-kqs5h` is `2/2 Running` on digest
  `sha256:f183391e56cf5b52ee1d1cf73fbade982d46f357633b7942ebf674e6e8ef4f0a` with zero restarts.
- Sim pod `torghut-sim-00297-deployment-6bcf98d4bc-pcc4f` is `2/2 Running` on the same digest with zero restarts.
- Options catalog pod `torghut-options-catalog-6cbf647d57-vvlsz` is `1/1 Running` on the same digest with zero restarts.
- Options enricher pod `torghut-options-enricher-75b888bd98-5r2vs` is `1/1 Running` on the same digest with zero
  restarts.
- `kubectl get pods -n torghut --field-selector=status.phase!=Running` returned no resources.
- Recent rollout events show expected startup/readiness probe failures while new pods started, followed by Knative
  `RevisionReady` and `LatestReadyUpdate` events for `torghut-00217` and `torghut-sim-00297`.

Endpoint evidence refreshed at 2026-05-05T17:56Z:

- Live `/healthz`: HTTP 200.
- Live `/trading/status`: HTTP 200, reporting version `v0.568.5-16-g59511b6b6`, commit
  `59511b6b6af8b160aaf00b9fb5f44b7a62c61c5c`, and active revision `torghut-00217`.
- Live `/readyz`: HTTP 503 with scheduler, Postgres, ClickHouse, Alpaca, database, and universe checks OK, but overall
  readiness degraded.
- Live `/trading/health`: HTTP 503. Live order submission remains blocked by the intended no-live-submit posture.
- Sim `/healthz`, `/readyz`, `/trading/status`, and `/trading/health`: HTTP 200 on active revision
  `torghut-sim-00297`.
- Options enricher `/healthz` and `/readyz`: HTTP 200 with a fresh success timestamp.
- Options catalog `/healthz`: HTTP 200 and `/v1/options/hot-set`: HTTP 200 with 160 symbols.
- Options catalog `/readyz`: HTTP 503 with `ready=false`, `last_success_ts=null`, and no error code or detail.
- Live TA REST, sim TA REST, and options TA REST `/overview`: HTTP 200 with one running Flink job on each service.

Read-only log evidence:

- Options catalog access logs still show repeated `GET /readyz` responses at HTTP 503 while `/healthz` and
  `/v1/options/hot-set` continue to return HTTP 200.
- Options enricher logs show steady HTTP 200 responses for `/readyz` and `/healthz`.
- Live Torghut logs show HTTP 503 for `/trading/health`, while `/healthz`, `/trading/status`, and metrics endpoints
  continue to return HTTP 200.

Event notes:

- Expected transient rollout warnings appeared while new revisions and hooks scheduled: startup/readiness probe failures,
  old-revision shutdown readiness failures, and hook startup events.
- Persistent residual warnings observed during inspection were pre-existing `MultiplePodDisruptionBudgets` for
  ClickHouse pods and older websocket liveness restarts before this rollout.
- No non-running Torghut pods remained after hook cleanup.

## Risk And Rollback

Residual risks:

- Live order submission is intentionally blocked. Treat `simple_submit_disabled` as the current trading gate: the
  cluster rollout is applied, but live trading remains no-go until executable proof exists and a follow-up PR re-enables
  submit.
- The #5514 image is reconciled and pod-ready, but production application health is not fully green because live Torghut
  readiness and trading health are 503 under the no-live-submit posture.
- Options catalog readiness is the active post-merge blocker: pod readiness and `/healthz` are green, and persisted
  hot-set reads work, but service `/readyz` is 503 with no successful catalog cycle timestamp.
- #5412 remains unmerged because Codex review capacity is exhausted. It should stay blocked until a Codex review posts
  and all resulting threads resolve, or until a maintainer explicitly waives the gate.
- Direct Argo Application CR reads are blocked for `system:serviceaccount:agents:agents-sa`; use a credential with
  Application read access for direct sync inspection.

Rollback path:

- For #5514, revert merge commit `76709ed093bcff552d3a73c14d3563883ad5e81c` or open a new GitOps promotion PR back to
  the previous known-good Torghut image digest
  `sha256:5b1685a25cd2d708373d928b095a641b0fe65d0887820f70f32f4e6147bd9bb0`, then let Argo CD reconcile.
- Because the current blockers are application-readiness semantics and the options catalog worker readiness state, not
  pod crashes or schema failures, rollback should be reserved for image-specific regression evidence such as new crashes,
  missing hot-set data, endpoint regressions beyond the known 503s, or sustained options catalog failure past the
  operator tolerance window.
- For #5412, do not merge until the Codex review gate clears or a maintainer waives it. If #5412 later merges and live
  submission health regresses, revert the shared live-gate change or promote a prior Torghut image through normal GitOps.

## Owner Update Message

Rollout state is blocked at application health, not GitOps. I squash-merged #5514 after every required check passed, and
Argo synced Torghut and Torghut options to main revision `be72b6213` between 2026-05-05T17:35:04Z and
2026-05-05T17:38:43Z. Live and sim moved to `torghut-00217` and `torghut-sim-00297` on digest `f183391e` with zero
restarts; sim health, live `/healthz`, live `/trading/status`, TA, TA-sim, options TA, and options-enricher are green.
I am not declaring production health green because refreshed checks at 2026-05-05T17:56Z still show live `/readyz` and
`/trading/health` at 503 under the no-live-submit posture, and options catalog `/readyz` is 503 with `ready=false` and no
successful catalog cycle timestamp.
Rollback is a revert of #5514 merge commit `76709ed09` or a GitOps promotion back to digest `5b1685a25`; first
remediation should focus on options catalog readiness and the explicit health semantics for live no-submit.

## Next Action

Keep #5412 blocked until Codex review capacity returns or a maintainer explicitly waives the large-diff review gate.
For the merged #5514 rollout, continue probing options catalog `/readyz` and catalog logs; if readiness does not recover
within the operator tolerance window, open a fix-forward PR for catalog readiness semantics or a GitOps rollback PR to
the previous image digest.
