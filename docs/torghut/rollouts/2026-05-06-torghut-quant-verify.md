# Torghut quant verifier release gate - 2026-05-06

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-06T08:55Z

## Owner update message

No-go on the Torghut release gate. The small Torghut unblocker #5649 and the prior audit PR #5646 are
already merged, and the latest open Torghut runtime PR is still #5412. PR #5412 is conflict-free and
green in CI on head `df361911e250fa315002c776e8ac4a53dc781e69`, but it is a 3,165-line large diff
with zero posted reviews and zero review threads. The latest current-head Codex review request returned
the usage-limit blocker, so I did not merge and did not start a #5412 rollout.

## Open PR enumeration

- #5412, `feat(torghut): add evidence epochs and shared live gate`, is the primary Torghut quant
  runtime PR. It is selected and held.
- #5649, `fix(torghut): unblock historical simulation proof setup`, appeared during the verification
  window. It was selected as a small unblocker PR, verified, and merged.
- #5646, `docs(torghut): refresh quant verify gate`, was the previous audit PR on the required verify
  branch and is now merged.
- #5594 is Jangar-scoped and outside the Torghut quant release gate.
- #5316 is an older automated release PR and was not selected for Torghut quant promotion work.

## Gate decisions

#5412 remains no-go for merge:

- `gh pr view 5412 --json additions,deletions,changedFiles` reports 3,138 additions, 27 deletions,
  and 20 files changed.
- GraphQL reports zero reviews and zero review threads.
- `mergeable=MERGEABLE` and `mergeStateStatus=CLEAN`.
- `gh pr checks 5412` reports Torghut CI, Pyright, pytest/coverage, quality signals, argo-lint,
  kubeconform, semantic PR title, semantic commits, and changed-file checks as passing; unrelated app
  and deploy gates are skipped.
- Current head is `df361911e250fa315002c776e8ac4a53dc781e69`.
- The latest current-head `@codex review` request returned the Codex usage-limit response at
  2026-05-06T08:46:58Z, so no Codex review has posted.

#5649 was go for merge:

- PR size was 175 additions and 94 deletions across 5 files, below the large-diff Codex review gate.
- GraphQL reported zero reviews, zero review requests, and zero review threads.
- GitHub checks all passed or skipped: `Bytecode + pytest + coverage`, `Pyright`,
  `Quality signals (complexity + security)`, argo-lint, kubeconform, semantic PR title, semantic
  commits, and changed-file checks passed; unrelated app and deploy-enable jobs were skipped.
- `git merge-tree --write-tree origin/main refs/remotes/origin/pr/5649` completed without conflict.
- `git diff --check origin/main...refs/remotes/origin/pr/5649` passed.

## PRs touched

- #5412: inspected, held, and left unmerged because the mandatory large-diff Codex review has not
  posted.
- #5649: selected, verified, and squash-merged to main at
  `cfeb86f5cd0d70a74b4d5ed4aecfb4123282a5c9`.
- #5646: refreshed as the prior durable audit artifact for this release gate and merged at
  `bbfa3f8eb0a5511928b736c5b7c8f3cac0e51954`.
- #5638 and #5635: previously merged Torghut image promotions used as pre-existing rollout baseline;
  neither was modified during this refresh.

## Comments and conflicts

- #5412 has no merge conflicts, no posted reviews, and zero review threads.
- #5649 had no comments, no review requests, zero review threads, and a clean local merge-tree result.
- The #5412 progress comment remains anchored with `<!-- codex:progress -->` and documents the
  Codex review usage-limit blocker.
- The progress comment is updated through `services/jangar/scripts/codex/codex-progress-comment.ts`.

## Merge outcomes

- #5649: merged by squash at `cfeb86f5cd0d70a74b4d5ed4aecfb4123282a5c9`.
- #5412: held, not merged.
- #5646: audit PR merged by squash at `bbfa3f8eb0a5511928b736c5b7c8f3cac0e51954`.

## Validation

- PASS: `/usr/local/bin/codex-nats-soak` wrote `.codex-nats-context.json`; it fetched 25 recent
  general-channel messages and found no matching branch/run messages.
- PASS: `gh pr list -R proompteng/lab --state open --limit 100` identified #5412 as the only open
  Torghut candidate during the latest refresh; #5646 and #5649 are merged.
- PASS: `gh pr checks 5412 -R proompteng/lab` showed all visible #5412 checks passing or skipped.
- PASS: `gh pr checks 5649 -R proompteng/lab` showed all visible #5649 checks passing or skipped.
- PASS: `git merge-tree --write-tree origin/main refs/remotes/origin/pr/5649`.
- PASS: `git diff --check origin/main...origin/codex/swarm-torghut-quant`.
- PASS: `git diff --check origin/main...refs/remotes/origin/pr/5649`.
- PASS: `bunx oxfmt --check docs/torghut/rollouts/2026-05-06-torghut-quant-verify.md`.
- PASS: `git diff --check`.

## Deployment evidence

GitOps state after #5649:

- `kubectl get applications.argoproj.io -n argocd torghut torghut-options -o custom-columns=...`
  reported:
  - `torghut`: `Synced`, `Healthy`, revision `cfeb86f5cd0d70a74b4d5ed4aecfb4123282a5c9`, operation
    `Succeeded`, message `successfully synced (no more tasks)`.
  - `torghut-options`: `Synced`, `Healthy`, revision `cfeb86f5cd0d70a74b4d5ed4aecfb4123282a5c9`,
    operation `Succeeded`, message `successfully synced (all tasks run)`.

Workload readiness:

- PASS: `kubectl rollout status -n torghut deployment/torghut-00233-deployment --timeout=60s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-sim-00314-deployment --timeout=60s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-options-catalog --timeout=60s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-options-enricher --timeout=60s`.
- `kubectl get pods -n torghut --field-selector=status.phase!=Running,status.phase!=Succeeded -o name`
  returned no resources.
- Current promoted pods are ready with zero restarts:
  - `torghut-00233-deployment-67bcd45899-f4n8r`: `2/2`, image digest
    `sha256:9e4146a183a6e73567f0005e3990a7f50aa4f9b3bdbcf8e37cfbf959c647a2d0`.
  - `torghut-sim-00314-deployment-849dccc4f4-4qczs`: `2/2`, same Torghut image digest.
  - `torghut-options-catalog-97b7d56fb-hrtj6`: `1/1`, same Torghut image digest.
  - `torghut-options-enricher-66bccb45fc-kqrm5`: `1/1`, same Torghut image digest.

Runtime probes:

- PASS: `curl http://torghut.torghut.svc.cluster.local/healthz` returned HTTP 200.
- PASS: `curl http://torghut.torghut.svc.cluster.local/` returned HTTP 200 with version
  `v0.568.5-137-g8a130c304` and commit `8a130c3047a48c60c5c8bd96c3d8aeee95b9ac7c`.
- PASS: `curl http://torghut.torghut.svc.cluster.local/trading/status` returned HTTP 200 with
  `live_submission_gate.allowed=false`.
- PASS: `curl http://torghut-sim.torghut.svc.cluster.local/readyz` returned HTTP 200.
- PASS: `curl http://torghut-options-catalog.torghut.svc.cluster.local/healthz` returned HTTP 200.
- PASS: `curl http://torghut-options-catalog.torghut.svc.cluster.local/v1/options/hot-set` returned
  HTTP 200.
- PASS: `curl http://torghut-options-enricher.torghut.svc.cluster.local/healthz` returned HTTP 200.
- PASS: `curl http://torghut-options-enricher.torghut.svc.cluster.local/readyz` returned HTTP 200.
- RESIDUAL: `curl http://torghut.torghut.svc.cluster.local/readyz` and `/trading/health` returned
  HTTP 503 because `live_submission_gate.reason=simple_submit_disabled` and `capital_stage=shadow`.
  This is the intended business gate, not a failed #5649 rollout.

Events and RBAC:

- Recent warning events after the #5649 merge were recurring ClickHouse
  `MultiplePodDisruptionBudgets` warnings. They predate #5649 and remain residual cluster hygiene
  debt.
- The prior Flink status-update warning still showed the Flink job state as `RUNNING` in the event
  payload.
- The verifier service account can read Argo Applications, Deployments, Pods, Events, and service
  probes. It cannot directly mutate production and no direct production mutation was performed.

## Risk

- #5412 is the main release risk and must stay unmerged until Codex review capacity is restored and
  any resulting review threads are resolved, or a maintainer explicitly waives the large-diff gate.
- Live capital remains intentionally shadow-blocked by `simple_submit_disabled`; the healthy rollout
  does not imply live capital enablement.
- ClickHouse multiple-PDB warnings remain non-blocking cluster hygiene debt for this gate.

## Rollback path

- For #5649: open a GitOps PR reverting `cfeb86f5cd0d70a74b4d5ed4aecfb4123282a5c9`, then let Argo CD
  reconcile. Do not mutate production directly outside an emergency.
- Rollback triggers: Argo `torghut` or `torghut-options` becomes Degraded or stuck OutOfSync, rollout
  hooks fail, promoted workloads lose readiness, or runtime probes regress beyond the documented
  live-capital shadow gate.
- For #5412: no runtime rollback is required because it was not merged. Keep live promotion flags
  disabled while the review gate is blocked.

## Next action

Keep #5412 open and blocked; re-request Codex review only after review quota is restored, then resolve
any threads, refresh against current main, wait for all checks to pass, squash-merge, and repeat
GitOps/workload/event verification.
