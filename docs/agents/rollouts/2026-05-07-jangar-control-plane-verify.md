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
- Other open PRs observed at release start were outside this Jangar control-plane scope:
  #5797 temporal release soak, #5767 release automation, #5412 Torghut, #5316 release automation.

## Comments and conflicts

- Conflicts: none. PR #5796 was mergeable before CI completed.
- Review threads: none returned by the final PR review thread query.
- Progress comment: updated with `services/jangar/scripts/codex/codex-progress-comment.ts` after merge to record the
  merge commit and rollout-verification checkpoint.

## Merge gate

Go. The final observed check set for #5796 was terminal green or skipped:

- `agents-ci / integration`: pass after local Jangar control-plane image build/preload and agents integration smoke test.
- `agents-ci / validate`: pass.
- `jangar-ci / lint-and-typecheck`: pass.
- `packages-scripts / lint-and-test`: pass.
- Semantic PR and semantic commit checks: pass.
- Path-gated app checks and deploy enable checks: skipped.

No merge action was duplicated for #5796. GitHub reported #5796 already merged at the final mergeability recalculation
checkpoint. #5803 was squash-merged after its semantic checks were green and review threads were clean.

## Rollout evidence

- Git ancestry passed. The live GitOps sync revision includes #5796, #5804, and #5803:

  ```bash
  git merge-base --is-ancestor bf3633c752179267850ba2cb41d584bb4a685790 48fe998e09430fabd7e7aab47ef4637e21f3151d
  ```

- Argo CD:
  - `jangar`: Synced / Healthy at sync revision `48fe998e09430fabd7e7aab47ef4637e21f3151d`.
  - `agents`: Synced / Healthy at sync revision `48fe998e09430fabd7e7aab47ef4637e21f3151d`.
  - `symphony-jangar`: Synced / Healthy at sync revision `48fe998e09430fabd7e7aab47ef4637e21f3151d`.
- Workload readiness:
  - `kubectl -n jangar rollout status deployment/jangar --timeout=60s`: successfully rolled out.
  - `kubectl -n agents rollout status deployment/agents --timeout=180s`: successfully rolled out.
  - `kubectl -n agents rollout status deployment/agents-controllers --timeout=180s`: successfully rolled out.
- Jangar health:
  - `kubectl get --raw /api/v1/namespaces/jangar/services/jangar:80/proxy/health` returned
    `{"status":"ok","service":"jangar",...}`.
  - Current serving pod `jangar-74cd8d8fcd-rtjth` is Running with `app:true:0` and `docker:true:0`.
  - Serving image:
    `registry.ide-newton.ts.net/lab/jangar:1744b973@sha256:fe165d874349d309ae43fdeedd64934f0dde6cd748c92dade8992e86c2dfbaa3`.
- Agents workloads:
  - `agents-696458c8d8-4kq2g` is Running, Ready, and at zero restarts.
  - `agents-controllers-7fb755f476-q2mp5` and `agents-controllers-7fb755f476-vsh2j` are Running, Ready, and at
    zero restarts.
- Runtime verifier:
  - `bun run packages/scripts/src/jangar/verify-deployment.ts --require-synced --expected-revision
bf3633c752179267850ba2cb41d584bb4a685790 --expected-revision-mode ancestor` passed from an `origin/main`
    worktree.
  - It verified digest `sha256:fe165d874349d309ae43fdeedd64934f0dde6cd748c92dade8992e86c2dfbaa3`.
  - It verified admission passports for `serving`, `swarm_plan`, and `swarm_implement`.
  - It verified recovery warrants, runtime proof cells, and deploy-verification watermarks.
- Swarm health:
  - `swarm/jangar-control-plane` phase `Active`.
  - Conditions: `Ready=True`, `Frozen=False`, `Progressing=False`, `Degraded=False`, `RequirementsBridge=True`.

## Residual risk

- Before #5804 landed, strict expected-revision verification timed out because #5796 did not change Jangar GitOps
  manifests and Argo had no new sync operation for the Jangar app. #5804 created a new Jangar sync operation and the
  same strict verifier then passed against current `origin/main`.
- One warning event remained from the latest startup: a transient readiness connection refusal on
  `jangar-74cd8d8fcd-rtjth`. The pod is currently Ready with zero restarts.
- Historical failed schedule pods exist in `agents`; current Jangar, Agents, and Agents controller workloads are ready.

## Rollback path

- For the #5796 verifier behavior, revert merge commit `bf3633c752179267850ba2cb41d584bb4a685790`.
- For this audit note, revert merge commit `48fe998e09430fabd7e7aab47ef4637e21f3151d` or its follow-up correction.
- For emergency deploy verification bypass only, use `--skip-runtime-proof-verification` or
  `JANGAR_VERIFY_RUNTIME_PROOF_SURFACE=false`. Skipping admission passport verification also bypasses this
  proof-surface check.
- For runtime rollout regression unrelated to #5796, open a GitOps revert PR against the image promotion that last
  changed `argocd/applications/jangar/kustomization.yaml` and `argocd/applications/agents/values.yaml`, then rerun the
  same Argo, rollout, health, digest, and proof-surface checks.

## Next action

- No runtime blocker remains for #5796, #5804, or #5803. The follow-up audit correction should preserve the final
  `48fe998e0` rollout evidence on `main`.
