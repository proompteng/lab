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

No merge action was duplicated from this runner. GitHub reported #5796 already merged at the final mergeability
recalculation checkpoint.

## Rollout evidence

- Git ancestry passed. The live GitOps sync revision includes #5796:

  ```bash
  git merge-base --is-ancestor bf3633c752179267850ba2cb41d584bb4a685790 1744b97362812407f8863a9f935903f645217303
  ```

- Argo CD:
  - `jangar`: Synced / Healthy at sync revision `1744b97362812407f8863a9f935903f645217303`.
  - `agents`: Synced / Healthy at sync revision `1744b97362812407f8863a9f935903f645217303`.
  - `symphony-jangar`: Synced / Healthy at sync revision `1744b97362812407f8863a9f935903f645217303`.
- Workload readiness:
  - `kubectl -n jangar rollout status deployment/jangar --timeout=60s`: successfully rolled out.
  - `kubectl -n agents rollout status deployment/agents --timeout=60s`: successfully rolled out.
  - `kubectl -n agents rollout status deployment/agents-controllers --timeout=60s`: successfully rolled out.
- Jangar health:
  - `kubectl get --raw /api/v1/namespaces/jangar/services/jangar:80/proxy/health` returned
    `{"status":"ok","service":"jangar",...}`.
  - Current serving pod `jangar-59f474c888-9zj6j` is Running with `app:true:0` and `docker:true:0`.
  - Serving image:
    `registry.ide-newton.ts.net/lab/jangar:840b22ce@sha256:0733ed13551f208f7355ddc6170838db2240689734391f9b7e30aa6cfb581253`.
- Runtime verifier:
  - `bun run packages/scripts/src/jangar/verify-deployment.ts --require-synced` passed.
  - It verified digest `sha256:0733ed13551f208f7355ddc6170838db2240689734391f9b7e30aa6cfb581253`.
  - It verified admission passports for `serving`, `swarm_plan`, and `swarm_implement`.
  - It verified recovery warrants, runtime proof cells, and deploy-verification watermarks.
- Swarm health:
  - `swarm/jangar-control-plane` phase `Active`.
  - Conditions: `Ready=True`, `Frozen=False`, `Progressing=False`, `Degraded=False`, `RequirementsBridge=True`.

## Residual risk

- The strict expected-revision verifier timed out:

  ```bash
  bun run packages/scripts/src/jangar/verify-deployment.ts --require-synced --expected-revision bf3633c752179267850ba2cb41d584bb4a685790 --expected-revision-mode ancestor
  ```

- Reason: Jangar's Argo `status.sync.revision` advanced to `1744b97362812407f8863a9f935903f645217303`, but
  `status.operationState.syncResult.revision` remained at the prior image-promotion operation
  `7d66464cdc487d962041d8493f46e3ab07a932f2`. The verifier reports the last operation revision as the deployed
  revision, so this command is too strict for a PR that does not change Jangar GitOps manifests.
- One warning event remained from startup: a transient readiness connection refusal on `jangar-59f474c888-9zj6j`
  after the image-promotion rollout. The pod is currently Ready with zero restarts.
- Historical failed schedule pods exist in `agents`; current Jangar and agents workloads are ready.

## Rollback path

- For the #5796 verifier behavior, revert merge commit `bf3633c752179267850ba2cb41d584bb4a685790`.
- For emergency deploy verification bypass only, use `--skip-runtime-proof-verification` or
  `JANGAR_VERIFY_RUNTIME_PROOF_SURFACE=false`. Skipping admission passport verification also bypasses this
  proof-surface check.
- For runtime rollout regression unrelated to #5796, open a GitOps revert PR against the image promotion that last
  changed `argocd/applications/jangar/kustomization.yaml` and `argocd/applications/agents/values.yaml`, then rerun the
  same Argo, rollout, health, digest, and proof-surface checks.

## Next action

- No runtime blocker remains for #5796. The follow-up audit PR should preserve this evidence on `main`.
