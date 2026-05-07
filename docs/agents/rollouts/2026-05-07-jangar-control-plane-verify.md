# Jangar control-plane release verification - 2026-05-07

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane-verify`
Release engineer: Marco Silva

## Current pass - 11:58 UTC

### PRs touched

- #5852 `chore(jangar): promote image 817b46ca`
  - Selected as the latest merged Jangar GitOps promotion requiring rollout verification in this pass.
  - Source image tag: `817b46ca`.
  - Merge commit: `d28c5057ab8d7e7e89f86ac74d352890deac8b0d`.
  - Merged at 2026-05-07T11:35:56Z after semantic, argo-lint, kubeconform, `jangar-ci`, and deploy-enable checks
    were pass or skipped.
  - Progress comment: https://github.com/proompteng/lab/pull/5852#issuecomment-4396880450.
- #5412 `feat(torghut): add renewal bond profit escrow`
  - Rechecked as the only open PR returned by a Jangar search.
  - Not selected for merge: the PR is Torghut-scoped, remains over the 1000-line large-diff threshold, and still lacks
    the required Codex review because the review connector is returning the account usage-limit blocker.
  - Progress comment: https://github.com/proompteng/lab/pull/5412#issuecomment-4378206627.

Current open PR enumeration at the merge gate:

- #5859 `ci(torghut): use bun for revenue repair summary`: Torghut CI workflow, merged into `main` as `ef36fad05`
  while this audit was running.
- #5857 `test(temporal-bun-sdk): widen heartbeat lifecycle budgets`: Temporal SDK scoped; not selected for Jangar.
- #5855 `feat(torghut): add chip autoresearch workflow`: Torghut scoped; pending checks during enumeration.
- #5767 `chore(release/c3ba60b): automated release PR`: app GitOps release scoped; not selected for Jangar.
- #5412 `feat(torghut): add renewal bond profit escrow`: Jangar-adjacent Torghut runtime work; blocked by large-diff
  review policy.
- #5316 `chore(release/735ddbc): automated release PR`: docs GitOps release scoped; not selected for Jangar.

### Comments and conflicts

- #5364, #5376, and #5387 from the stale May 5 handoff are already merged with green recorded check sets.
- No open direct `services/jangar`, `argocd/applications/jangar`, or `argocd/applications/agents` implementation PR was
  present during this pass.
- #5412 review-thread query returned no active threads, but the mandatory large-diff Codex review has not posted.
- #5852 was already merged before this pass; no conflict repair was required.

### Merge gate

Go for the already-merged #5852 rollout verification. No new Jangar implementation PR was available for merge in this
pass.

- #5852 PR checks before merge were terminal green or skipped:
  - `Semantic Commits / Lint commit messages`.
  - `Semantic Pull Request / Validate PR title`.
  - `argo-lint / lint`.
  - `kubeconform / validate`.
  - `jangar-ci / lint-and-typecheck`.
  - `jangar-deploy-automerge / enable`.
- Mainline workflows after #5852:
  - `jangar-build-push` for head `817b46ca` succeeded.
  - `agents-ci` for head `817b46ca` succeeded.
  - `jangar-post-deploy-verify` for merge commit `d28c5057` succeeded.
- #5412 merge decision remains no-go until Codex review posts and any review threads are resolved, or a maintainer
  explicitly waives the large-diff gate.

### Rollout evidence

- Argo CD:
  - `jangar`: Synced / Healthy, reconciled at 2026-05-07T11:49:49Z.
  - `agents`: Synced / Healthy, reconciled at 2026-05-07T11:52:28Z.
- Workload readiness:
  - `kubectl rollout status deployment/jangar -n jangar --timeout=30s`: successfully rolled out.
  - `kubectl rollout status deployment/agents -n agents --timeout=30s`: successfully rolled out.
  - `kubectl rollout status deployment/agents-controllers -n agents --timeout=30s`: successfully rolled out.
- Serving images:
  - `jangar`: `registry.ide-newton.ts.net/lab/jangar:817b46ca@sha256:729353bc285a1a6c45670a287c7472278537b85765bf4a35b666e75626c1305f`.
  - `agents`: `registry.ide-newton.ts.net/lab/jangar-control-plane:817b46ca@sha256:29cff7a0d76213ce1c035394568ac09f5e42394261c015c0df45309f9d10023b`.
  - `agents-controllers`: `registry.ide-newton.ts.net/lab/jangar:817b46ca@sha256:729353bc285a1a6c45670a287c7472278537b85765bf4a35b666e75626c1305f`.
- Current pods:
  - `jangar-98f54c787-xwwzs`: Running, `app:true`, `docker:true`, zero restarts.
  - `agents-686467787-s7d8k`: Running, Ready, zero restarts.
  - `agents-controllers-77bbbc7799-2m7zc` and `agents-controllers-77bbbc7799-s8swj`: Running, Ready, zero
    restarts.
- Jangar health:
  - `http://jangar.jangar.svc.cluster.local/health` returned `{"status":"ok","service":"jangar",...}`.
  - `http://jangar.jangar.svc.cluster.local/ready` returned `{"status":"ok","service":"jangar",...}` with
    `leaderElection.isLeader=true`, `lastError=null`, and `execution_trust.status=healthy`.
  - `http://agents.agents.svc.cluster.local/ready` returned `{"status":"ok","service":"jangar",...}` with
    `execution_trust.status=healthy`.
- Runtime verifier:
  - This command passed:
    ```bash
    bun run packages/scripts/src/jangar/verify-deployment.ts --require-synced --expected-revision d28c5057ab8d7e7e89f86ac74d352890deac8b0d --expected-revision-mode ancestor --health-attempts 3 --health-interval-seconds 2 --digest-attempts 3 --digest-interval-seconds 2
    ```
  - The verifier confirmed digest parity, admission passports for `serving`, `swarm_plan`, and `swarm_implement`,
    runtime kit image refs, recovery warrants, runtime proof cells, and deploy-verification watermarks.

### Residual risk

- Startup readiness probe warnings occurred during the #5852 replacement, then cleared. Current Jangar and Agents pods
  are Ready with zero restarts.
- Jangar logs include non-fatal metrics export socket failures and transient Kubernetes 429 watch warnings. The live
  `/ready` endpoint remains `status=ok`, so these are operational noise to monitor rather than rollback triggers.
- #5412 remains a policy blocker outside the direct Jangar rollout lane because the mandatory Codex review cannot post
  while the connector is usage-limited.

### Rollback path

- If the `817b46ca` rollout regresses readiness, digest parity, or Jangar control-plane health, open a GitOps revert PR
  for #5852 merge commit `d28c5057ab8d7e7e89f86ac74d352890deac8b0d` in:
  - `argocd/applications/jangar/kustomization.yaml`.
  - `argocd/applications/jangar/deployment.yaml`.
  - `argocd/applications/agents/values.yaml`.
- If the source behavior from #5843 is implicated after image rollback, revert
  `3c7e24de3b9085531cd47cd28955045ddb68860d` through a normal PR and let `jangar-build-push` plus `jangar-release`
  produce a new promotion.
- Do not mutate production workloads directly from a local shell; promotion and rollback remain PR-driven GitOps.

### Next action

- Runtime rollout gate: go. #5852 is merged, post-deploy verification passed, Argo is Synced/Healthy, workloads are
  ready, and live images match GitOps.
- Merge gate: no direct open Jangar implementation PR remains selected. #5412 remains no-go pending Codex review or an
  explicit maintainer waiver.

## Current pass - 09:24 UTC

### PRs touched

- #5814 `fix(jangar): fail closed unstamped swarm runner admission`
  - Selected as the only open direct Jangar control-plane implementation PR in this pass.
  - Head: `9f120eb3318c6433b639b2cc71d5745722994996`.
  - Merge commit: `be164bc127abb3a9c1b8ed97d2a34597a8ee90e6`.
  - Merged at 2026-05-07T09:03:24Z after the final observed PR check set was pass or skipped.
  - Generated image promotion #5820.
- #5820 `chore(jangar): promote image be164bc1`
  - Source commit: `be164bc127abb3a9c1b8ed97d2a34597a8ee90e6`.
  - Image tag: `be164bc1`.
  - Jangar image digest:
    `sha256:146f2790c661890f6480da020b4b94ea65528250c9f72b1baec52c516934d241`.
  - Control-plane image digest:
    `sha256:a069354d947c28828607a54e80395f67047232d3871f9fe3dfd04fdc2c5c04e8`.
  - Merge commit: `1b1414273e3d36eeb3be811e59c0e2d2be5d73ba`.
  - Merged at 2026-05-07T09:17:56Z by automation; the final observed check set completed pass or skipped before
    rollout signoff.

Other open PRs during this pass were Temporal, Torghut, audit, or release-automation scoped and were not selected for
the direct Jangar control-plane rollout gate.

### Comments and conflicts

- Blocking review threads: none returned by GitHub review-thread queries for #5814 or #5820.
- #5814 conflicts: `git merge-tree --write-tree origin/main origin/codex/swarm-jangar-control-plane` returned tree
  `7543aa1f85d08dd90550e228a887c6dc8ffcf759` with no conflict diagnostics before merge.
- #5820 conflicts: no conflicts surfaced before merge; the generated GitOps promotion PR merged cleanly into `main`.
- Progress comments were refreshed with `services/jangar/scripts/codex/codex-progress-comment.ts`:
  - #5814: https://github.com/proompteng/lab/pull/5814#issuecomment-4395578466.
  - #5820: https://github.com/proompteng/lab/pull/5820#issuecomment-4395810758.

### Merge gate

Go for #5814 and #5820.

- #5814 checks were terminal green or skipped before merge action:
  - `jangar-ci / lint-and-typecheck`.
  - `agents-ci / validate`.
  - `agents-ci / integration` passed in 11m31s.
  - Semantic PR/title checks passed; path-gated deploy/app checks skipped.
- #5820 promotion checks were terminal green or skipped before rollout signoff:
  - `argo-lint / lint`.
  - `kubeconform / validate`.
  - `jangar-ci / lint-and-typecheck` passed in 2m21s.
  - `jangar-deploy-automerge / enable` passed.
  - Semantic PR/title checks passed; unrelated deploy enable checks skipped.
- Process note: the manual squash merge commands for both #5814 and #5820 returned "already merged". #5820 automation
  merged before the final `jangar-ci` check had completed, so rollout verification did not proceed until that check
  later completed green.

### Rollout evidence

- Image build:
  - `jangar-build-push` run `25486447656` succeeded in 12m43s for `be164bc1`.
  - Release contract artifact recorded Jangar digest
    `sha256:146f2790c661890f6480da020b4b94ea65528250c9f72b1baec52c516934d241` and control-plane digest
    `sha256:a069354d947c28828607a54e80395f67047232d3871f9fe3dfd04fdc2c5c04e8`.
- Argo CD after #5820:
  - `jangar`: Synced / Healthy at revision `a37189b1e7a06120c5e1691fd1356b51d5a9bfe9`, which includes #5820 by
    ancestry.
  - `agents`: Synced / Healthy at revision `7b57284dee72779c1abf1d42b0b2d3387f143ce4`, which includes #5820 by
    ancestry.
  - `symphony-jangar`: Synced / Healthy at revision `7b57284dee72779c1abf1d42b0b2d3387f143ce4`, which includes
    #5814 by ancestry.
- Workload readiness:
  - `kubectl -n jangar rollout status deployment/jangar --timeout=180s`: successfully rolled out.
  - `kubectl -n agents rollout status deployment/agents --timeout=180s`: successfully rolled out.
  - `kubectl -n agents rollout status deployment/agents-controllers --timeout=180s`: successfully rolled out.
  - Current pods are Ready with zero restarts: `jangar-75d54f6fbc-5cs4r`, `agents-6c6888ffd5-hfnks`,
    `agents-controllers-5fb745fc5f-6pv84`, and `agents-controllers-5fb745fc5f-mb4sn`.
- Serving images:
  - `jangar`: `registry.ide-newton.ts.net/lab/jangar:be164bc1@sha256:146f2790c661890f6480da020b4b94ea65528250c9f72b1baec52c516934d241`.
  - `agents`: `registry.ide-newton.ts.net/lab/jangar-control-plane:be164bc1@sha256:a069354d947c28828607a54e80395f67047232d3871f9fe3dfd04fdc2c5c04e8`.
  - `agents-controllers`: `registry.ide-newton.ts.net/lab/jangar:be164bc1@sha256:146f2790c661890f6480da020b4b94ea65528250c9f72b1baec52c516934d241`.
- Runtime verifier:
  - `bun run packages/scripts/src/jangar/verify-deployment.ts --require-synced --expected-revision
1b1414273e3d36eeb3be811e59c0e2d2be5d73ba --expected-revision-mode ancestor --health-attempts 3
--health-interval-seconds 2 --digest-attempts 3 --digest-interval-seconds 2` passed.
  - The verifier confirmed digest parity, admission passports for `serving`, `swarm_plan`, and `swarm_implement`,
    runtime kit image refs, sealed recovery warrants, runtime proof cells, and deploy-verification watermarks.
- Jangar health:
  - `kubectl get --raw /api/v1/namespaces/jangar/services/jangar:80/proxy/health` returned `{"status":"ok",...}`.
  - Control-plane status reported `execution_trust=healthy`, `database=healthy`, `watch_reliability=healthy`, 622
    watch events, zero watch errors, and zero watch restarts.

### Residual risk

- Recent warning events were startup readiness probes during replacement:
  - `jangar-75d54f6fbc-5cs4r` had a transient readiness connection refusal and is now Ready with zero restarts.
  - `agents-6c6888ffd5-hfnks` and current `agents-controllers` pods had transient readiness timeouts and are now Ready
    with zero restarts.
- Runtime authority is healthy for deploy widening, but not for all material actions:
  - Namespace `agents` remains degraded on `empirical:forecast`.
  - `dispatch_normal` is `repair_only` pending fresh controller-process witnesses.
  - `paper_canary` and `live_micro_canary` are `hold`; `live_scale` is `block` pending forecast/paper-settlement
    repairs.
- The #5820 deploy automation merged before one PR check completed. The check later passed before rollout signoff; no
  rollback trigger remains from CI.

### Rollback path

- If `be164bc1` regresses readiness, digest parity, or Jangar control-plane health, open a GitOps PR reverting #5820
  merge commit `1b1414273e3d36eeb3be811e59c0e2d2be5d73ba` in:
  - `argocd/applications/jangar/kustomization.yaml`.
  - `argocd/applications/jangar/deployment.yaml`.
  - `argocd/applications/agents/values.yaml`.
- If the #5814 fire-time admission behavior is implicated after image rollback, revert
  `be164bc127abb3a9c1b8ed97d2a34597a8ee90e6` through a normal PR and let the Jangar build/release workflows produce a
  new promotion.
- Emergency rollback for the fire-time admission check only is `JANGAR_SCHEDULE_RUNNER_ADMISSION_CHECK=false`; keep
  `JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT=true` unless intentionally moving launcher admission to advisory-only.
- Do not mutate production workloads from a local shell; rollback remains PR-driven GitOps.

### Next action

- Runtime rollout gate: go. #5814 and #5820 are merged, final observed checks are pass/skipped, Argo is Synced/Healthy,
  workloads are ready, live images match the release contract, and the deployment verifier passed.
- Material-action gate: no-go for paper/live widening until `empirical:forecast` and controller witness repairs clear.
- Keep watching for a follow-up Jangar PR; no open direct Jangar control-plane implementation PR remained selected at
  this pass closeout.

## Current pass - 08:46 UTC

### PRs touched

- #5802 `fix(jangar): back off rate-limited watch restarts`
  - Head: `b6157c14493eb5479477082cd3404f1481e1049c`.
  - Merge commit: `8036d91ac30b52c9faa8ae6e7570f90fc07916bc`.
  - Merged at 2026-05-07T08:07:15Z after required checks were pass or skipped.
  - Generated image promotion #5808.
- #5808 `chore(jangar): promote image 8036d91a`
  - Source commit: `8036d91ac30b52c9faa8ae6e7570f90fc07916bc`.
  - Image tag: `8036d91a`.
  - Image digest: `sha256:8d3c1fabcd52d24f19dcd6508c25928693cc5bc017df9941e9f3cce245829c2a`.
  - Merge commit: `d8cee2b8879a79a82490eeabf9f082fd600fd952`.
  - Merged at 2026-05-07T08:21:02Z after promotion checks were pass or skipped.
- #5805 `fix(jangar): require sealed warrants for swarm launches`
  - Head: `2c3633ff3e41d8bf27b405e766c8774a9dc84977`.
  - Merge commit: `885368c6ff68b1aba7396587624a53d30a1d1380`.
  - Merged at 2026-05-07T08:26:49Z after required checks were pass or skipped.
  - Generated image promotion #5813.
- #5813 `chore(jangar): promote image 885368c6`
  - Source commit: `885368c6ff68b1aba7396587624a53d30a1d1380`.
  - Image tag: `885368c6`.
  - Jangar image digest:
    `sha256:209c72e339afc54ee854a24f62d4941480931f23ae0ed5cb31fd1d9fec19ed06`.
  - Control-plane image digest:
    `sha256:acaf78bb1c5f4804de4a131aaf209b70e23b22215703a93257c4c653838b57a6`.
  - Merge commit: `8a47fcd199c5adb05d76f67bf7956db5144e86b1`.
  - Merged at 2026-05-07T08:39:53Z after promotion checks were pass or skipped.
- #5412 `feat(torghut): add renewal bond profit escrow`
  - Rechecked as a Jangar-adjacent open PR.
  - Not selected for merge: 5,950 additions and 485 deletions exceed the >1000-line Codex review gate, and no
    mandatory Codex review is posted.

Other open PRs at final audit were Torghut or release-automation scoped and were not selected for this direct Jangar
control-plane pass.

### Comments and conflicts

- Conflicts: none on #5802 or #5805. `git merge-tree --write-tree origin/main <pr-head>` returned no conflicts before
  merge.
- Blocking comments: none found on #5802, #5805, #5808, or #5813.
- Progress comments were refreshed with `services/jangar/scripts/codex/codex-progress-comment.ts`:
  - #5802: https://github.com/proompteng/lab/pull/5802#issuecomment-4395244278.
  - #5805: https://github.com/proompteng/lab/pull/5805#issuecomment-4395240687.
  - #5813: https://github.com/proompteng/lab/pull/5813#issuecomment-4395541075.
  - #5412 blocker note: https://github.com/proompteng/lab/pull/5412#issuecomment-4378206627.

### Merge gate

Go for the selected Jangar PRs and their generated promotions.

- #5802 passed local validation in this runner:
  - `bunx vitest run --config vitest.config.ts src/server/__tests__/kube-watch.test.ts src/server/__tests__/control-plane-status.test.ts`.
  - `bunx oxfmt --check services/jangar/src/server/kube-watch.ts services/jangar/src/server/control-plane-workflows.ts services/jangar/src/server/__tests__/kube-watch.test.ts services/jangar/src/server/__tests__/control-plane-status.test.ts`.
  - `bun run --filter @proompteng/jangar tsc`.
  - `bunx oxlint --config ../../.oxlintrc.json src/server/kube-watch.ts src/server/control-plane-workflows.ts src/server/__tests__/kube-watch.test.ts src/server/__tests__/control-plane-status.test.ts`.
- #5802 GitHub checks passed or skipped, including `agents-ci / validate`, `agents-ci / integration`, and
  `jangar-ci / lint-and-typecheck`.
- #5805 GitHub checks passed or skipped, including `agents-ci / validate`, `agents-ci / integration`, and
  `jangar-ci / lint-and-typecheck`.
- #5808 and #5813 promotion checks passed or skipped, including semantic checks, `argo-lint`, `kubeconform`,
  `jangar-ci / lint-and-typecheck`, and `jangar-deploy-automerge / enable`.
- #5412 remains no-go despite green visible checks because the mandatory large-diff Codex review is not posted.

### Rollout evidence

- Mainline build:
  - #5802 image build `jangar-build-push` run `25483890242` succeeded for tag `8036d91a`.
  - #5805 image build `jangar-build-push` run `25484759414` succeeded for tag `885368c6`.
- Argo CD after #5813:
  - `jangar`: Synced / Healthy at revision `8a47fcd199c5adb05d76f67bf7956db5144e86b1`.
  - `agents`: Synced / Healthy at revision `8a47fcd199c5adb05d76f67bf7956db5144e86b1`.
  - `symphony-jangar`: Synced / Healthy at revision `315dde4b8581598309238c2989b95451a167c110`, which includes
    #5813 by ancestry.
- Workload readiness:
  - `kubectl -n jangar rollout status deployment/jangar --timeout=180s`: successfully rolled out.
  - `kubectl -n agents rollout status deployment/agents --timeout=180s`: successfully rolled out.
  - `kubectl -n agents rollout status deployment/agents-controllers --timeout=180s`: successfully rolled out.
- Serving images:
  - `jangar`: `registry.ide-newton.ts.net/lab/jangar:885368c6@sha256:209c72e339afc54ee854a24f62d4941480931f23ae0ed5cb31fd1d9fec19ed06`.
  - `agents`: `registry.ide-newton.ts.net/lab/jangar-control-plane:885368c6@sha256:acaf78bb1c5f4804de4a131aaf209b70e23b22215703a93257c4c653838b57a6`.
  - `agents-controllers`: `registry.ide-newton.ts.net/lab/jangar:885368c6@sha256:209c72e339afc54ee854a24f62d4941480931f23ae0ed5cb31fd1d9fec19ed06`.
- Current pods:
  - `jangar-6d748b8587-dzmht`: Running, Ready, zero restarts.
  - `agents-5d666cc5d9-h6tpl`: Running, Ready, zero restarts.
  - `agents-controllers-c9dff996c-5x78m` and `agents-controllers-c9dff996c-bpn5x`: Running, Ready, zero restarts.
- Runtime verifier:
  - First run failed because the local worktree still held the #5808 digest while the cluster had already rolled #5813.
  - After fast-forwarding to current `origin/main`,
    `bun run packages/scripts/src/jangar/verify-deployment.ts --require-synced --expected-revision
8a47fcd199c5adb05d76f67bf7956db5144e86b1 --expected-revision-mode ancestor --health-attempts 3
--health-interval-seconds 2 --digest-attempts 3 --digest-interval-seconds 2` passed.
  - The verifier confirmed digest parity, admission passports for `serving`, `swarm_plan`, and `swarm_implement`,
    runtime kit image refs, sealed recovery warrants, runtime proof cells, and deploy-verification watermarks.
- Jangar health:
  - `kubectl get --raw /api/v1/namespaces/jangar/services/jangar:80/proxy/health` returned `{"status":"ok",...}`.
  - Control-plane status reports `rollout_health.status=healthy`, two observed deployments, zero degraded
    deployments, and watch reliability healthy over the 15-minute window with 472 events, zero errors, and zero
    restarts.

### Residual risk

- Kubernetes and GitOps rollout are healthy. Runtime authority is not fully green:
  - `execution_trust.status=degraded`.
  - Reason: `verify stage is stale`.
  - Dependency quorum decision: `delay`.
  - Namespace `agents` remains degraded on `empirical:forecast` and `execution_trust`.
- Recent warning events after #5813 were transient startup/readiness or termination warnings:
  - `jangar-6d748b8587-dzmht` had one readiness connection refusal during startup and is now Ready with zero restarts.
  - Old `8036d91a` Agents pods emitted readiness/liveness warnings during replacement and are no longer current pods.
- #5412 is still a merge blocker outside the selected direct Jangar rollout because it is over the large-diff review
  threshold and lacks the mandatory Codex review.

### Rollback path

- If the `885368c6` image regresses readiness, digest parity, or control-plane rollout health, open a GitOps PR reverting
  #5813 in:
  - `argocd/applications/jangar/kustomization.yaml`.
  - `argocd/applications/jangar/deployment.yaml`.
  - `argocd/applications/agents/values.yaml`.
- If the source behavior from #5805 is implicated after image rollback, revert
  `885368c6ff68b1aba7396587624a53d30a1d1380` through a normal PR and let `jangar-build-push` plus `jangar-release`
  produce a new promotion.
- Emergency behavioral rollback toggles for #5805:
  - `JANGAR_SWARM_RUNTIME_PROOF_ENFORCEMENT=false` keeps passport enforcement but disables strict proof enforcement.
  - `JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT=false` makes launcher admission advisory-only.
- If #5802 watch backoff behavior is implicated, revert `8036d91ac30b52c9faa8ae6e7570f90fc07916bc` through a normal
  PR and promote the resulting image through GitOps.
- Do not use a local shell mutation to bypass Argo CD; promotion and rollback remain PR-driven GitOps changes.

### Next action

- Runtime rollout gate: go. #5802, #5805, #5808, and #5813 are merged, checks are terminal green or skipped, Argo is
  healthy, workloads are ready, and the verifier passed.
- Runtime authority gate: no-go for material-action/deploy-widening until the stale `verify` stage evidence refreshes
  and `execution_trust` returns healthy.
- #5412 remains blocked pending mandatory Codex review.

## PRs touched

- #5796 `fix(jangar): verify runtime proof surface on deploy`
  - Selected as the only open Jangar control-plane implementation PR.
  - Head: `5e64238d3499b7854591c9146456ff489300cf4d`.
  - Merge commit: `bf3633c752179267850ba2cb41d584bb4a685790`.
  - Merged at 2026-05-07T07:32:22Z after required checks were pass or skipped.
- #5803 `docs(jangar): record control-plane release verification`
  - Added this release audit note.
  - Merge commit: `48fe998e09430fabd7e7aab47ef4637e21f3151d`.
  - Merged at 2026-05-07T07:54:13Z after required checks were pass or skipped.
- #5804 `chore(jangar): promote image 1744b973`
  - Landed while #5803 was merging and changed the live Jangar and Agents GitOps manifests.
  - Merge commit: `a81ede050f6dfec36605e93d5e634af977d9a984`.
  - Treated as a fresh rollout gate before final handoff.
- #5805 `fix(jangar): require sealed warrants for swarm launches`
  - Merged after a new Jangar control-plane PR opened during release closeout.
  - Head: `2c3633ff3e41d8bf27b405e766c8774a9dc84977`.
  - Merge commit: `885368c6ff68b1aba7396587624a53d30a1d1380`.
  - Merged at 2026-05-07T08:26:49Z after required checks were pass or skipped.
- #5813 `chore(jangar): promote image 885368c6`
  - Promoted the #5805 image into Jangar and Agents GitOps manifests.
  - Merge commit: `8a47fcd199c5adb05d76f67bf7956db5144e86b1`.
  - Auto-merged by deploy automation at 2026-05-07T08:39:53Z; remaining post-merge checks later passed.
- Other open PRs observed at release start were outside this Jangar control-plane scope:
  #5797 temporal release soak, #5767 release automation, #5412 Torghut, #5316 release automation.

## Comments and conflicts

- Conflicts: none across the selected Jangar PRs.
- Review threads: none returned by final review-thread queries for #5796, #5805, #5806, and #5813.
- Progress comments: updated with `services/jangar/scripts/codex/codex-progress-comment.ts` on #5796, #5805, #5806,
  and #5813 to record the current merge or rollout checkpoint.

## Merge gate

Go. The final observed check sets for selected Jangar PRs were terminal green or skipped:

- `agents-ci / integration`: pass after local Jangar control-plane image build/preload and agents integration smoke test.
- `agents-ci / validate`: pass.
- `jangar-ci / lint-and-typecheck`: pass.
- `packages-scripts / lint-and-test`: pass.
- Semantic PR and semantic commit checks: pass.
- #5813 `kubeconform / validate` and `argo-lint / lint`: pass.
- #5813 `jangar-post-deploy-verify / verify`: pass.
- Path-gated app checks and deploy enable checks: skipped.

No merge action was duplicated for #5796. GitHub reported #5796 already merged at the final mergeability recalculation
checkpoint. #5803, #5805, and #5806 were squash-merged after checks were green and review threads were clean. #5813
was auto-merged by deploy automation before manual action from this runner; its remaining post-merge checks completed
green before final rollout closeout.

## Rollout evidence

- Git ancestry passed. The live GitOps sync revision includes #5796, #5804, #5805, and #5813:

  ```bash
  git merge-base --is-ancestor 885368c6ff68b1aba7396587624a53d30a1d1380 8a47fcd199c5adb05d76f67bf7956db5144e86b1
  ```

- Argo CD:
  - `jangar`: Synced / Healthy at sync revision `8a47fcd199c5adb05d76f67bf7956db5144e86b1`.
  - `agents`: Synced / Healthy at sync revision `8a47fcd199c5adb05d76f67bf7956db5144e86b1`.
  - `symphony-jangar`: Synced / Healthy at sync revision `8a47fcd199c5adb05d76f67bf7956db5144e86b1`.
- Workload readiness:
  - `kubectl -n jangar rollout status deployment/jangar --timeout=180s`: successfully rolled out.
  - `kubectl -n agents rollout status deployment/agents --timeout=180s`: successfully rolled out.
  - `kubectl -n agents rollout status deployment/agents-controllers --timeout=180s`: successfully rolled out.
- Jangar health:
  - `kubectl get --raw /api/v1/namespaces/jangar/services/jangar:80/proxy/health` returned
    `{"status":"ok","service":"jangar",...}`.
  - Current serving pod `jangar-6d748b8587-dzmht` is Running with `app:true` / `docker:true` and zero restarts.
  - Serving image:
    `registry.ide-newton.ts.net/lab/jangar:885368c6@sha256:209c72e339afc54ee854a24f62d4941480931f23ae0ed5cb31fd1d9fec19ed06`.
- Agents workloads:
  - `agents-5d666cc5d9-h6tpl` is Running, Ready, and at zero restarts on
    `registry.ide-newton.ts.net/lab/jangar-control-plane:885368c6@sha256:acaf78bb1c5f4804de4a131aaf209b70e23b22215703a93257c4c653838b57a6`.
  - `agents-controllers` is Running with two Ready replicas on the 885368c6 Jangar image digest.
- Runtime verifier:
  - `bun run packages/scripts/src/jangar/verify-deployment.ts --require-synced --expected-revision
885368c6ff68b1aba7396587624a53d30a1d1380 --expected-revision-mode ancestor` passed from an `origin/main`
    worktree.
  - It verified digest `sha256:209c72e339afc54ee854a24f62d4941480931f23ae0ed5cb31fd1d9fec19ed06`.
  - It verified admission passports for `serving`, `swarm_plan`, and `swarm_implement`.
  - It verified recovery warrants, runtime proof cells, and deploy-verification watermarks.
- Post-deploy verifier:
  - `jangar-post-deploy-verify / verify` for #5813 passed in 3m16s.
- Swarm health:
  - `swarm/jangar-control-plane` phase `Active`.
  - Conditions: `Ready=True`, `Frozen=False`, `Progressing=False`, `Degraded=False`, `RequirementsBridge=True`.

## Residual risk

- Before #5804 landed, strict expected-revision verification timed out because #5796 did not change Jangar GitOps
  manifests and Argo had no new sync operation for the Jangar app. #5804 created a new Jangar sync operation and the
  same strict verifier then passed against current `origin/main`.
- One warning event remained from the latest startup: a transient readiness connection refusal on
  `jangar-6d748b8587-dzmht`. The pod is currently Ready with zero restarts.
- Two warning events remained from old `agents-controllers` pods during termination. Current Agents controller replicas
  are ready on the 885368c6 image.
- Historical failed schedule pods exist in `agents`; current Jangar, Agents, and Agents controller workloads are ready.

## Rollback path

- For the #5796 verifier behavior, revert merge commit `bf3633c752179267850ba2cb41d584bb4a685790`.
- For the #5805 sealed-warrant launch behavior, revert merge commit
  `885368c6ff68b1aba7396587624a53d30a1d1380`.
- For the live 885368c6 rollout, open a GitOps revert PR reverting #5813 merge commit
  `8a47fcd199c5adb05d76f67bf7956db5144e86b1`, then rerun Argo, rollout, health, digest, and proof-surface checks.
- For this audit note, revert merge commit `48fe998e09430fabd7e7aab47ef4637e21f3151d` or its follow-up corrections.
- For emergency deploy verification bypass only, use `--skip-runtime-proof-verification` or
  `JANGAR_VERIFY_RUNTIME_PROOF_SURFACE=false`. Skipping admission passport verification also bypasses this
  proof-surface check.
- For emergency proof-layer rollback without disabling passport enforcement, set
  `JANGAR_SWARM_RUNTIME_PROOF_ENFORCEMENT=false`.
- For runtime rollout regression unrelated to #5796, open a GitOps revert PR against the image promotion that last
  changed `argocd/applications/jangar/kustomization.yaml` and `argocd/applications/agents/values.yaml`, then rerun the
  same Argo, rollout, health, digest, and proof-surface checks.

## Next action

- No runtime blocker remains for #5796, #5804, #5805, #5813, or the audit correction PRs. Keep watching normal service
  telemetry for the transient startup warnings noted above.
