# Torghut Quant Release Gate - 2026-05-06

Release engineer: Julian Hart
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Repository: `proompteng/lab`

## Decision

No-go for merge.

Selected PR #5412, `feat(torghut): add evidence epochs and shared live gate`, is open, non-draft,
mergeable, and has green visible GitHub checks. The merge is blocked because the PR changes 3,165
lines and the large-diff gate requires a posted Codex review before squash merge. A fresh review
request at 2026-05-06T03:55:12Z returned a Codex connector usage-limit response at
2026-05-06T03:55:21Z, so the required review is still absent.

## PRs Touched

- #5412: selected Torghut production PR. Head `codex/swarm-torghut-quant` at
  `c6147b522832ee04246f35451c88be509f0c8846`; base `main`.
- #5594: open Jangar PR; not selected for this Torghut release gate.
- Automated release PRs #5501, #5497, #5482, #5477, #5470, and #5316: not selected because they are
  release-branch housekeeping PRs rather than the Torghut quant implementation gate.

## Checks And Comments

- GitHub shows #5412 as `MERGEABLE` / `CLEAN`.
- GraphQL review thread query for #5412 returned no review threads.
- GitHub checks on #5412 are passing for:
  - `torghut-ci` Pyright
  - `torghut-ci` Bytecode + pytest + coverage
  - `torghut-ci` Quality signals
  - `argo-lint` lint
  - `kubeconform` validate
  - Semantic Pull Request
  - Semantic Commits
  - `CI` check_changed_files
- Path-filtered jobs are skipped, not failing.
- No code conflicts were repaired in this verifier branch. The only PR-thread action was a fresh
  `@codex review` request and an updated `<!-- codex:progress -->` comment on #5412.

## Merge Outcome

No squash merge was performed.

The hard blocker is external Codex review capacity, not Torghut code/test status. Merging #5412 now
would violate the large-diff review gate because there is no posted Codex review and no review
threads to resolve.

## Deployment Evidence

No post-merge rollout exists for #5412 because the PR was not merged.

Current read-only GitOps and cluster state at the verifier checkpoint:

- Argo CD applications `torghut`, `torghut-options`, and `symphony-torghut` are `Synced` and
  `Healthy` at main revision `831e241d6082d659ea226db952bf74ef84a1f4af`.
- `kubectl rollout status` succeeded for:
  - `deployment/torghut-00228-deployment`
  - `deployment/torghut-sim-00309-deployment`
  - `deployment/torghut-options-catalog`
  - `deployment/torghut-options-enricher`
  - `deployment/torghut-ta`
  - `deployment/torghut-ws`
- `kubectl get pod -n torghut --field-selector=status.phase!=Running,status.phase!=Succeeded`
  returned no resources.
- Recent Torghut namespace events include repeated ClickHouse multiple-PDB warnings and
  `torghut-keeper` PDB `NoPods` notices. They are residual operational warnings on the current
  deployed revision, not evidence of a #5412 rollout.
- The service account could list deployments and pods, but could not list Knative Service or apps
  StatefulSet resources in the `torghut` namespace. That read-only RBAC limit does not change the
  merge decision because Argo application health and deployment readiness were visible.

## Risk

- #5412 adds a migration and shared live-gate behavior. The code checks are green, but the changed
  line count is large enough to require independent Codex review before production promotion.
- Because the PR is not merged, there is no new image, migration job, or Argo reconciliation to
  validate for this change.
- Current cluster health is good for the already-deployed main revision, but it is not proof that
  #5412 is safe to promote.

## Rollback Path

If #5412 is later reviewed, merged, and then fails rollout:

- Stop promotion through GitOps by reverting the merge commit with a new PR to `main`.
- Let the Torghut release workflow produce a rollback release PR that restores the previous known
  good Torghut image digest, currently observed in GitOps and workloads as
  `sha256:158767dbfe9d6298700a6f048bff97160694e62eca363ddad36816cfafb620a2`.
- Watch Argo CD `torghut`, `torghut-options`, and `symphony-torghut` return to `Synced` /
  `Healthy`; verify deployment readiness and absence of non-running pods in the `torghut`
  namespace before closing the rollback.

## Next Action

Restore Codex review capacity, request a real Codex review on #5412, resolve any resulting threads,
then re-check GitHub checks and squash-merge only if every required gate remains green. After merge,
verify the GitOps rollout against the merged commit and document the new revision, image digest,
workload readiness, and error-event status.
