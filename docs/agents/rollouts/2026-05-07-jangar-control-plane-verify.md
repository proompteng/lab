# Jangar control-plane release verification - 2026-05-07

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane-verify`
Release engineer: Marco Silva

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
