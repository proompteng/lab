# Jangar Control Plane Release Verification

Timestamp: 2026-05-07T15:36:00Z
Repository: `proompteng/lab`
Base: `main`
Release branch: `codex/swarm-jangar-control-plane-verify`
Observed main: `2fa59585c9533b6ed2eacdb232502920bdb52139`

## Owner Update Message

Jangar and Torghut rollout are currently healthy. #5884 merged as
`8e3f342e3f31927f016dece75eed0660b9bec280`, and the generated GitOps promotion #5890 merged as
`c5b9101f22f57b6251c30ce1c458ddd056e31455`, promoting Torghut image digest
`sha256:9c5c85848ba0b46253f374f7f670fd5d201c043e33a2bc7d85149efc1db3f4b0`.

The first `torghut-post-deploy-verify` attempt timed out before Argo finished hooks and Knative readiness, opening
rollback PR #5895. Direct cluster checks then showed the new live/sim Torghut pods Ready with `/healthz` 200s, and
rerun attempt 2 of `torghut-post-deploy-verify` run `25504560579` passed at 2026-05-07T15:34:22Z. I closed #5895 as a
stale timeout artifact.

Current Argo evidence at 2026-05-07T15:36Z: `torghut` and `jangar` are both Synced, Healthy, and operation Succeeded at
revision `2fa59585c9533b6ed2eacdb232502920bdb52139`. The remaining merge gates are no-go, not runtime failures: #5889
and #5412 both exceed the large-diff Codex review threshold and review requests are blocked by the Codex usage-limit
response; #5889 also still has `agents-ci / integration` pending.

## PRs Touched

- #5884, `fix(torghut): expose route-scoped tca evidence`
  - Head: `9139b805c3971d4cdc1d5c2945d7c7639441cb61`.
  - Merged as `8e3f342e3f31927f016dece75eed0660b9bec280`.
  - Progress comment:
    https://github.com/proompteng/lab/pull/5884#issuecomment-4398077532.
- #5890, `chore(torghut): promote image 8e3f342e`
  - Generated promotion for #5884.
  - Merged as `c5b9101f22f57b6251c30ce1c458ddd056e31455`.
  - Progress comment:
    https://github.com/proompteng/lab/pull/5890#issuecomment-4398555447.
- #5891, `chore(jangar): promote image 061ec2b2`
  - Landed during this release window.
  - Merged as `5dae5708ba494e9ad942cc745781f8cfb8562b54`.
  - Post-deploy verifier `25504664273` passed.
- #5895, `revert(torghut): rollback failed promotion c5b9101f22f57b6251c30ce1c458ddd056e31455`
  - Opened by the first failed #5890 post-deploy attempt.
  - Closed at 2026-05-07T15:35:36Z after verifier attempt 2 passed and cluster state was healthy.
- #5889, `feat(jangar): add repair warrant exchange`
  - Direct Jangar PR.
  - Not merged: 1,448 changed lines, Codex review request hit usage-limit response, and `agents-ci / integration`
    was still pending.
  - Progress comment:
    https://github.com/proompteng/lab/pull/5889#issuecomment-4398288855.
- #5412, `feat(torghut): add renewal bond profit escrow`
  - Not merged: clean and green, but 6,368 changed lines and Codex review still blocked by usage limits.
  - Progress comment:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4378206627.

## Comments And Conflicts

- #5884 and #5890 had no blocking review comments or active conflict at their merge gates.
- #5889 has the required Codex review request trail, but the connector replied with the Codex usage-limit blocker.
- #5412 has the required Codex review request trail, but repeated requests also returned the usage-limit blocker.
- #5895 was explicitly closed with a comment recording the successful verifier rerun and healthy Argo evidence.

## Merge Outcomes

- Merged:
  - #5884 -> `8e3f342e3f31927f016dece75eed0660b9bec280`.
  - #5890 -> `c5b9101f22f57b6251c30ce1c458ddd056e31455`.
  - #5891 -> `5dae5708ba494e9ad942cc745781f8cfb8562b54`.
- Closed as stale rollback artifact:
  - #5895.
- Held:
  - #5889: no-go until Codex review posts or maintainer waiver, with terminal required checks.
  - #5412: no-go until Codex review posts or maintainer waiver.

## Deployment Evidence

GitOps status from read-only `kubectl` checks:

- `torghut`: Synced, Healthy, operation Succeeded, revision `2fa59585c9533b6ed2eacdb232502920bdb52139`.
- `jangar`: Synced, Healthy, operation Succeeded, revision `2fa59585c9533b6ed2eacdb232502920bdb52139`.

Workload readiness:

- `deployment/torghut-00268-deployment`: 1/1 ready, 1 updated, 1 available.
- `deployment/torghut-sim-00368-deployment`: 1/1 ready, 1 updated, 1 available.
- `deployment/torghut-options-catalog`: 1/1 ready.
- `deployment/torghut-options-enricher`: 1/1 ready.
- `deployment/jangar`: 1/1 ready on
  `registry.ide-newton.ts.net/lab/jangar:061ec2b2@sha256:6cf402a7aee422df91581d4dd3b3096c8c07e145a6e29070c6fac59429b3cb54`.

Torghut promoted image:

- `registry.ide-newton.ts.net/lab/torghut:8e3f342e@sha256:9c5c85848ba0b46253f374f7f670fd5d201c043e33a2bc7d85149efc1db3f4b0`.

Validation commands and results:

- `gh pr checks 5884 -R proompteng/lab`: pass or skipped before merge.
- `gh pr checks 5890 -R proompteng/lab --watch --interval 10`: pass or skipped after the PR validation finished.
- `gh run watch 25504560614 -R proompteng/lab --exit-status`: pass.
- `gh run view 25504560579 -R proompteng/lab --json status,conclusion,attempt,jobs,updatedAt,url`: attempt 2 pass.
- `gh run view 25504664273 -R proompteng/lab --json status,conclusion,jobs,url`: pass.
- `kubectl get applications.argoproj.io torghut jangar -n argocd ...`: Synced/Healthy/Succeeded.
- `kubectl get deploy -n torghut torghut-00268-deployment torghut-sim-00368-deployment -o wide`: both 1/1.

## Risks And Rollback Path

Risks:

- The first post-deploy timeout was real workflow evidence and should stay in the audit trail. It cleared on rerun after
  Argo and Knative converged.
- #5889 and #5412 remain no-go because they lack mandatory Codex review coverage for large diffs.
- #5896 opened after this selected release slice and still had Torghut tests running at the audit timestamp; it was not
  selected for this Jangar gate.
- Pre-existing torghut warnings remain: ClickHouse multiple-PDB warning noise and one historical failed
  whitepaper-autoresearch job.

Rollback path:

- If Torghut digest `9c5c85848ba0b46253f374f7f670fd5d201c043e33a2bc7d85149efc1db3f4b0` regresses readiness or
  trading health, open a GitOps revert PR for #5890 across the Torghut Knative services, options deployments, and
  Torghut hook/workflow templates.
- #5895 contains the generated rollback patch from the transient first-attempt failure and can be reopened or
  regenerated if fresh evidence requires rollback.
- If #5884 source behavior is implicated after image rollback, revert
  `8e3f342e3f31927f016dece75eed0660b9bec280` through a normal PR and let the release workflows produce a replacement
  image promotion.
- Do not mutate production workloads directly from a local shell; all promotion and rollback remain PR-driven GitOps.

## Next Action

Open and merge the documentation-only audit PR from `codex/swarm-jangar-control-plane-verify` after its checks pass.
Keep #5889 and #5412 blocked until the Codex review gate is satisfied or explicitly waived by a maintainer.
