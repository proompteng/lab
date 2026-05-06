# Torghut quant verifier follow-up - 2026-05-06

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`

## Decision

Partial go for audit merge; no-go for the large Torghut implementation merge.

The current verifier branch is documentation-only and records the release gate after `main` moved. It
is safe to merge once its lightweight checks pass because it does not change runtime manifests,
trading code, or capital controls.

PR #5412, `feat(torghut): add evidence epochs and shared live gate`, remains blocked. GitHub reports
the PR mergeable with green visible checks, but the diff is above the 1,000-line Codex review
threshold and repeated `@codex review` requests returned usage-limit responses rather than a posted
review. I will not squash-merge #5412 until that review gate is satisfied or explicitly waived by a
maintainer.

## PRs touched

- #5412: selected Torghut implementation PR. State: open, mergeable, green visible checks, blocked
  by missing large-diff Codex review.
- #5616: prior audit PR on this verifier branch. State: merged at
  `ab8f66842126a28097075a65353aa12efc2dc2c8`.
- #5619: current verifier follow-up PR. State: documentation-only branch refreshed on current
  `main`; selected as the mergeable audit artifact for this release pass.
- #5620: stale Torghut image-promotion PR from `codex/torghut-release-2c6bba88`. Closed as
  superseded because its promoted image change is already on `main` through #5621, merge commit
  `44acf2666517e806c6cb93d344f5e4fba4896197`.
- #5621: Torghut image-promotion PR. State: merged; no extra merge action is required from this
  verifier branch.

## Comments and conflicts

- #5412 has no review threads to resolve. Its only blocker is the required Codex review not posting.
- #5619 had no review threads at refresh time.
- #5620 reported a merge conflict because the same image-promotion content was already squash-merged
  through #5621. I closed it as superseded rather than re-promoting the same digest from a stale
  base.

## Merge outcomes

- #5412: held, not merged.
- #5616: already merged before this follow-up.
- #5619: eligible for squash merge after checks pass.
- #5620: closed as superseded by #5621.
- #5621: already merged and present on `main`.

## Deployment evidence

No #5412 rollout exists because #5412 was not merged.

The image promotion from #5621 is on `main` and should be verified through GitOps after the verifier
audit merge completes. The required post-merge gate is:

- Argo CD applications `torghut`, `torghut-options`, and `symphony-torghut` are `Synced` and
  `Healthy`.
- Torghut namespace workloads with desired replicas are available.
- `kubectl get pods -n torghut --field-selector=status.phase!=Running,status.phase!=Succeeded`
  returns no unexpected active workload failures.
- Recent Torghut namespace warnings are triaged as residual or blocking before declaring rollout
  complete.

## Risk

- The #5412 code path changes shared live-gate behavior and evidence receipts. It remains a
  production no-go without independent review because the change size exceeds the Codex review gate.
- The current verifier PR is low runtime risk because it only updates release documentation.
- The stale #5620 PR would have confused release inventory if left open; it is now closed as
  superseded by #5621.

## Rollback path

- For this verifier PR: revert the documentation squash commit if the audit record is inaccurate.
- For #5621 image promotion: revert the image-promotion commit on `main` through a PR and let Argo CD
  reconcile the previous Torghut image digest.
- For a future #5412 merge: revert the #5412 squash commit through a PR, keep live-promotion flags
  disabled, and verify Argo sync, workload readiness, trading-status health, and error events before
  reopening promotion.

## Next action

Push this refreshed verifier branch, wait for #5619 checks, squash-merge #5619 if green, and then
verify current in-cluster GitOps health. Keep #5412 open and blocked until a real Codex large-diff
review posts and any resulting review threads are resolved.
