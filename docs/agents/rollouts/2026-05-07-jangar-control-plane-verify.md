# Jangar control-plane release verification - 2026-05-07

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane-verify`
Release engineer: Marco Silva

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
