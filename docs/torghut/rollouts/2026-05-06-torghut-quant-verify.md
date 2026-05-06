# Torghut quant verifier follow-up - 2026-05-06

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`

## 2026-05-06T06:05Z Release Gate Refresh

Gate decision: no-go for #5412; go for this documentation-only audit refresh.

#5412, `feat(torghut): add evidence epochs and shared live gate`, is still the only open Torghut
quant PR. GitHub reports it non-draft and mergeable/clean at
`c6147b522832ee04246f35451c88be509f0c8846`, and visible checks are green: Semantic Pull Request,
Semantic Commits, `check_changed_files`, argo-lint, kubeconform, Torghut Pyright, Torghut quality
signals, and Torghut bytecode/pytest/coverage. GraphQL reports zero reviews and zero review threads.

The merge blocker is unchanged: #5412 changes 3,138 additions and 27 deletions, so the large-diff
Codex review gate applies. The latest visible `@codex review` request returned the
`chatgpt-codex-connector` usage-limit response instead of a posted review. I refreshed the anchored
`<!-- codex:progress -->` PR comment with that no-go evidence and did not merge #5412.

Current GitOps and cluster evidence for already-merged `main` revision
`8016fe6d399e4b3bd901ecd01624e8260cc131a7`:

- Argo CD reports `torghut`, `torghut-options`, and `symphony-torghut` `Synced` and `Healthy`.
- `torghut` synced successfully at 2026-05-06T05:57:21Z and `torghut-options` at
  2026-05-06T05:54:28Z.
- `kubectl get pods -n torghut --field-selector=status.phase!=Running,status.phase!=Succeeded`
  returned no resources.
- All Torghut deployments with nonzero desired replicas report desired ready and available replicas,
  including live revision `torghut-00231-deployment`, sim revision `torghut-sim-00312-deployment`,
  options catalog, options enricher, options TA, TA, TA sim, websocket services, exporters, and
  `symphony-torghut`.
- Recent warning events were rollout/transient or residual: startup/readiness probe failures on old
  and newly created revisions that recovered, an EndpointSlice update timeout for the options
  enricher service, repeated ClickHouse multiple-PDB selection warnings, and a Flink status update
  race where the latest status in the event still reported the options TA job `RUNNING`, lifecycle
  `STABLE`, and job manager `READY`.
- The verifier service account can read Argo Applications, Pods, Deployments, Jobs, and Events, but
  it cannot read Knative Service/Revision or FlinkDeployment resources directly; Argo health and
  workload readiness are the available rollout sources for those controllers.

Rollback path is unchanged. #5412 has no production rollback action because it is unmerged. For the
current healthy main rollout, revert the relevant squash merge or image promotion PR through GitOps
if new crash loops, sustained readiness failures, failed post-deploy checks, or trading endpoint
regressions appear. Do not apply direct cluster mutations outside an emergency.

Next action: restore Codex review capacity, post the required #5412 Codex review, resolve any
threads, refresh against current `main` if needed, wait for all checks to complete green on the final
head, then squash-merge and verify Argo sync, workload readiness, and warning/error events for the
merged commit.

## Decision

Partial go for audit merge; no-go for the large Torghut implementation merge.

The current verifier branch is documentation-only and records the release gate after `main` moved. It
is safe to merge once its lightweight checks pass because it does not change runtime manifests,
trading code, or capital controls.

PR #5412, `feat(torghut): add evidence epochs and shared live gate`, remains blocked. GitHub reports
the PR mergeable with green visible checks, but the diff is above the 1,000-line Codex review
threshold and repeated `@codex review` requests returned usage-limit responses rather than a posted
review. I will not squash-merge #5412 until that review gate is satisfied.

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
