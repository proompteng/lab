# Jangar Control Plane Release Verification - 2026-05-05

Release engineer: Marco Silva
Swarm: jangar-control-plane
Branch: codex/swarm-jangar-control-plane-verify
Base: main

## 2026-05-05 22:23Z Release Update

- #5570 `fix(jangar): index torghut quant health lookup`
  - Selected as the unblock-first Jangar PR because it was a small production fix under the large-diff review threshold.
  - Merged at 2026-05-05T22:05:28Z as `49e27b93b72038f9a3a4bee28d9e8e0d041543a3`.
  - Required PR checks were pass/skipped only before merge: semantic title, semantic commits, `check_changed_files`,
    `jangar-ci / lint-and-typecheck`, `agents-ci / validate`, and `agents-ci / integration`.
  - `agents-ci / integration` passed in 13m28s.
- #5574 `chore(jangar): promote image 49e27b93`
  - Automated GitOps promotion for #5570.
  - Merged at 2026-05-05T22:16:24Z as `dd5ca99046541415e04908e4ac675424558297e6`.
  - Promoted Jangar image tag `49e27b93` with digest
    `sha256:9a28668ea8b1b63ee9afa3e1ae99dac5fb602b606740e524f38b8ed9cb31775a`.
  - PR checks were pass/skipped only: semantic title, semantic commits, argo-lint, kubeconform, deploy enable, and
    `jangar-ci / lint-and-typecheck`.
  - Post-merge `jangar-post-deploy-verify / verify` passed at 2026-05-05T22:17:53Z after deployment digest health
    verification and Temporal routing sync.
  - Main `agents-ci` for `49e27b93` passed in 13m28s.
- Rollout evidence at 2026-05-05T22:20:55Z:
  - Pod `jangar-ff5f988cd-rs2rp` was `2/2 Running` on `talos-192-168-1-85` with zero restarts.
  - Container image ID matched
    `registry.ide-newton.ts.net/lab/jangar@sha256:9a28668ea8b1b63ee9afa3e1ae99dac5fb602b606740e524f38b8ed9cb31775a`.
  - Pod conditions were `Ready=True` and `ContainersReady=True` since 2026-05-05T22:17:45Z.
  - `/health` returned ok.
  - `/api/agents/control-plane/status?namespace=agents` was reachable; database migration consistency was healthy,
    with latest registered/applied migration `20260505_torghut_quant_pipeline_health_window_index`.
  - Jangar events showed successful scale-up, image pull, and start for `jangar-ff5f988cd-rs2rp`; one transient startup
    readiness miss occurred before the pod became Ready.
- Residual risk:
  - Control-plane dependency quorum remained blocked by stale empirical jobs and intermittent Torghut readiness/status
    degradation; direct Torghut `/trading/status` was reachable on revision `torghut-00224`, but `/readyz` returned 503.
  - Jangar app logs in the stability window included control-plane heartbeat timeout warnings.
  - These are runtime dependency risks, not evidence of a failed #5570/#5574 image rollout.
- Rollback path:
  - If Jangar readiness, digest verification, or `/health` regresses, open a GitOps PR reverting #5574 changes in
    `argocd/applications/jangar/kustomization.yaml`, `argocd/applications/jangar/deployment.yaml`, and
    `argocd/applications/agents/values.yaml` back to the prior `01717359` promotion.
  - Prior known-good Jangar digest before #5574 was
    `sha256:a74d815597125bd164f7d4862af98e0f8bf1e50df765ace94d47b66566fb0f85`.
- Remaining merge gates:
  - #5454 is clean with pass/skipped checks but remains no-go because it exceeds 1,000 changed lines and no Codex
    review has posted after usage-limit responses.
  - #5412 is clean with pass/skipped checks but remains no-go for the same large-diff Codex review blocker.

## Release PR Inventory

- #5570 `fix(jangar): index torghut quant health lookup`
  - Selected for Jangar release attention.
  - State: merged at 2026-05-05T22:05:28Z as `49e27b93b72038f9a3a4bee28d9e8e0d041543a3`.
  - Rollout: promoted by #5574 and verified healthy by post-deploy verifier and direct pod/HTTP checks.
- #5574 `chore(jangar): promote image 49e27b93`
  - Selected as the GitOps promotion PR for #5570.
  - State: merged at 2026-05-05T22:16:24Z as `dd5ca99046541415e04908e4ac675424558297e6`.
  - Rollout: `jangar-post-deploy-verify / verify` passed.
- #5454 `feat(jangar): surface failure-domain lease holdbacks`
  - Selected for Jangar release attention.
  - State: open, non-draft, `MERGEABLE`, `CLEAN`.
  - Gate: no-go because the mandatory Codex review for a >1,000-line PR has not posted.
  - 2026-05-05T19:16Z recheck: checks remain pass/skipped only; GraphQL still reports
    `reviewThreads.totalCount=0` and `reviews.totalCount=0`.
- #5532 `docs(jangar): record control plane release verification`
  - Selected as the release-audit PR for this verification branch.
  - State: merged at 2026-05-05T19:00:09Z as merge commit `4f4e37372`.
  - Final check rollup observed as pass/skipped only.
- #5412 `feat(torghut): add evidence epochs and shared live gate`
  - Adjacent Torghut/shared-live-gate work, not selected as the primary Jangar-control-plane PR for this pass.
  - State: open, non-draft, `MERGEABLE`, `CLEAN`, but blocked by the same >1,000-line Codex review gate.
- #5537 `revert(torghut): roll back image 7e2fb9ce`
  - Adjacent Torghut rollback PR, not selected as a Jangar-control-plane merge candidate for this pass.
  - State: merged at 2026-05-05T19:00Z as merge commit `73d58f875`.

## PRs Touched

- #5376 `fix(torghut): restore live jangar dependency quorum`
  - State: merged at 2026-05-05T09:16:09Z.
  - Final check rollup observed as pass/skipped only.
- #5364 `ci: stabilize agents and jangar checks`
  - State: merged at 2026-05-05T09:21:18Z.
  - Final check rollup observed as pass/skipped only.
- #5387 `fix(torghut): restore rollout readiness`
  - State: merged at 2026-05-05T10:17:03Z.
  - Final check rollup observed as pass/skipped only.
- #5521 `fix(jangar): reconcile swarms from agentrun events`
  - State: merged at 2026-05-05T17:58:26Z.
  - Final check rollup observed as pass/skipped only.
- #5525 `chore(jangar): promote image a1b55322`
  - State: merged at 2026-05-05T18:11:09Z.
  - Final check rollup observed as pass/skipped only.
- #5538 `chore(jangar): promote image 919848c1`
  - State: merged at 2026-05-05T18:57:13Z.
  - Post-merge check rollup for merge commit `e7b852102` completed successfully: argo-lint `lint`, kubeconform
    `validate`, and `jangar-post-deploy-verify / verify`.
- #5532 `docs(jangar): record control plane release verification`
  - State: merged at 2026-05-05T19:00:09Z.
  - Final check rollup observed as pass/skipped only.
- #5454 `feat(jangar): surface failure-domain lease holdbacks`
  - State: open.
  - Mergeability: GitHub reported `MERGEABLE` and `CLEAN`.
  - Checks: pass/skipped only.
  - Gate: blocked because the PR is 1,538 additions and 4 deletions, which triggers the >1,000-line Codex review gate.

## Comments And Conflicts

- The selected earlier blockers (#5376, #5364, #5387) are already merged and no longer conflict with main.
- #5454 has no GitHub review threads and no posted reviews by GraphQL (`reviewThreads.totalCount=0`, `reviews.totalCount=0`).
- #5454 has two `@codex review` requests. Both bot responses report Codex code-review usage limits, so the required Codex review has not posted.
- Updated the anchored progress comment on #5454 using `services/jangar/scripts/codex/codex-progress-comment.ts`:
  https://github.com/proompteng/lab/pull/5454#issuecomment-4379440176.

## Merge Outcomes

- #5532 was squash-merged at 2026-05-05T19:00:09Z as release-audit evidence for this verification branch.
- #5454 must not be squash-merged until a Codex review is posted and all resulting review threads are resolved.
- The latest merged Jangar runtime path on main is #5521, #5531, and #5538, promoting image `919848c1` with digest
  `sha256:8651851a0b5baef46b9a10f933a56473313f3028658d41e1b68a73289cc9fd57`.

## Deployment Evidence

- Kubernetes identity: `system:serviceaccount:agents:agents-sa`.
- GitOps visibility is RBAC-limited:
  - `applications.argoproj.io` in `argocd`: forbidden.
  - `deployments.apps` in `jangar`: forbidden.
  - `pods`, `pods/log`, `services`, and `events` in `jangar`: readable.
- Jangar pod evidence after recovery:
  - Pod: `jangar-584d75f4f6-zt9b2`.
  - Image: `registry.ide-newton.ts.net/lab/jangar@sha256:cf398e6ab1dd7cc9df5a99bac655a90678d5acaace5ec7ba5b908ff9ee3d1478`.
  - Containers: `app ready=true restartCount=3`, `docker ready=true restartCount=0`.
  - Pod conditions: `Ready=True`, `ContainersReady=True`.
  - Health check: `curl http://jangar.jangar.svc.cluster.local/health` returned `{"status":"ok","service":"jangar",...}`.
  - App log: `[jangar] listening on http://0.0.0.0:8080` at 2026-05-05T18:31:25Z.
- Stability recheck at 2026-05-05T18:36Z:
  - `app ready=true restartCount=3`, unchanged from the first recovered observation.
  - `/health` still returned ok.
  - App logs for the prior two minutes were quiet.
- Stability recheck at 2026-05-05T18:55Z:
  - Pod list showed `jangar-584d75f4f6-zt9b2` as `2/2 Running` with `3` app restarts, last restart 23 minutes
    earlier.
  - Container status still reported `app ready=true restarts=3` and `docker ready=true restarts=0`.
  - Pod conditions still reported `Ready=True` and `ContainersReady=True`.
  - `/health` still returned ok.
  - App logs for the prior 10 minutes included Kubernetes API `Too Many Requests`, worktree snapshot refresh failures for
    unresolved PR refs, and ClickHouse freshness query timeouts.
- Rollout recheck after #5538 at 2026-05-05T19:01Z:
  - GitHub `jangar-post-deploy-verify / verify` for merge commit `e7b852102` completed successfully at
    2026-05-05T19:01:19Z after verifying deployment health/digest and syncing Temporal routing.
  - Pod list showed `jangar-847d6d7f8d-zx5sq` as `2/2 Running` on `talos-192-168-1-85`.
  - Container status reported `app ready=true restarts=0` with image ID
    `registry.ide-newton.ts.net/lab/jangar@sha256:8651851a0b5baef46b9a10f933a56473313f3028658d41e1b68a73289cc9fd57`
    and `docker ready=true restarts=0`.
  - Pod conditions reported `Ready=True` and `ContainersReady=True` at 2026-05-05T19:01:07Z.
  - `/health` returned ok.
  - App logs showed `leader election transition` for `jangar-847d6d7f8d-zx5sq` and
    `[jangar] listening on http://0.0.0.0:8080`; only a known Kysely `orderBy('column asc')` deprecation warning was
    present in the short startup tail.
  - Pod events for `jangar-847d6d7f8d-zx5sq` showed image pull/start success and one transient readiness probe
    connection-refused warning before the pod became Ready.
- Stability recheck after #5538 at 2026-05-05T19:05Z:
  - Pod list showed `jangar-847d6d7f8d-zx5sq` as `2/2 Running`, age 5m23s, with 0 restarts.
  - Container status still reported `app ready=true restarts=0` and `docker ready=true restarts=0`.
  - Pod conditions still reported `Ready=True` and `ContainersReady=True`.
  - `/health` still returned ok.
  - Jangar app logs for the prior two minutes were quiet.
  - RBAC checks still returned `no` for `applications.argoproj.io` in `argocd` and `deployments.apps` in `jangar`, while
    pod and event reads in `jangar` returned `yes`.
- Runtime-dependency recheck at 2026-05-05T19:15Z:
  - Pod `jangar-847d6d7f8d-zx5sq` remained `2/2 Running`; both containers were Ready with zero restarts, and the
    app image ID still matched digest `sha256:8651851a0b5baef46b9a10f933a56473313f3028658d41e1b68a73289cc9fd57`.
  - `/health` returned ok.
  - `/api/agents/control-plane/status?namespace=agents` reported database `healthy`, connected, and migration
    consistency `healthy`.
  - The same control-plane status reported dependency quorum `block` with reason `empirical_jobs_degraded`.
  - Torghut `/trading/status` was reachable on active revision `torghut-00219`, but empirical jobs were stale:
    `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
  - Torghut `/readyz` returned 503, and recent events included a `torghut-00219` readiness timeout.
  - Jangar app logs in the prior five minutes included Postgres `Query read timeout` and a control-plane heartbeat
    publish warning.
- Recent warning events before recovery:
  - `pod/jangar-584d75f4f6-zt9b2`: readiness probe connection refused and app container backoff.
  - `pod/jangar-db-1`: readiness probe returned HTTP 500.
  - Jangar app logs during failed starts showed Postgres `Query read timeout` during Kysely migrations.
- Remaining warning signal at the 18:36Z recheck:
  - `pod/jangar-db-1` still had a recent readiness probe HTTP 500 event, so database health remains a residual risk.
- Remaining warning signal at the 18:55Z recheck:
  - `pod/jangar-584d75f4f6-zt9b2` still had readiness/backoff warnings last seen 23 minutes earlier.
  - `pod/jangar-db-1` still had a readiness HTTP 500 warning last seen 11 minutes earlier.
- Remaining warning signal at the 19:05Z recheck:
  - The old `a1b55322` pod readiness/backoff warnings were 34 minutes old.
  - `pod/jangar-db-1` still had a readiness HTTP 500 warning last seen 6m12s earlier.
  - The initial `919848c1` pod readiness miss was 4m37s old and did not recur during the stability window.

## Risks

- Rollout cannot be fully certified through Argo CD or Deployment rollout APIs from this runner because the available service account lacks RBAC for those resources.
- The live Jangar pod is currently healthy by pod, digest, post-deploy verifier, and HTTP evidence. Recent CNPG
  readiness warnings and prior Kubernetes API 429s remain residual yellow signals even though the #5538 rollout itself
  is healthy.
- Full runtime rollout remains no-go because the control-plane dependency quorum is blocked by stale empirical jobs.
- #5454 remains blocked on Codex review capacity and must not be merged even though its branch is clean and checks are green.

## Rollback Path

- If the Jangar app becomes unready again after #5538, open a GitOps PR that reverts #5538 image promotions:
  - `argocd/applications/jangar/kustomization.yaml` back to tag `a1b55322` and digest
    `sha256:cf398e6ab1dd7cc9df5a99bac655a90678d5acaace5ec7ba5b908ff9ee3d1478`.
  - `argocd/applications/agents/values.yaml` back to Jangar tag `a1b55322`, Jangar digest
    `sha256:cf398e6ab1dd7cc9df5a99bac655a90678d5acaace5ec7ba5b908ff9ee3d1478`, and control-plane digest
    `sha256:eee4e33d3e17d948857cd3ecfe2f9dab77f68d84b3c943ae6d024fb3d4135aa5`.
- If reverting #5538 does not recover the app, widen rollback to #5525 by reverting to tag `e48d29c9`, Jangar digest
  `sha256:f0bec7dfbeea4bbe99c36d9f5a9e327c95bc36e57c0d021bc502e7a603d671aa`, and control-plane digest
  `sha256:65a524641f04d35524cfd86bc035592b5b8696cc0577c33feee8ed62cc5ef39e`.
- If DB readiness failures continue independently of the Jangar app image, treat rollback as insufficient and escalate the CNPG/API-server connectivity path with the event/log evidence above.

## Next Action

- Keep #5454 blocked until Codex review capacity is restored and a review is posted.
- Do not declare the control-plane runtime fully green until the stale empirical jobs dependency-quorum block is cleared
  or explicitly accepted by a maintainer.
- Recheck Jangar pod readiness, `/health`, warning events, app restart count, and Jangar app logs after the next stability
  window if any new Jangar promotion merges.
- Request RBAC or an alternate read credential for Argo CD Application and Deployment rollout status if full GitOps certification is required from this runner.
