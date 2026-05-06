# Torghut quant verifier release gate - 2026-05-06

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-06T09:03Z

## Owner update message

I merged the small Torghut unblocker #5649 after all visible checks passed and local merge-tree
validation showed no conflicts. The follow-on image promotion #5651 merged after the build completed,
and GitOps rollout is healthy: Argo CD reached Synced/Healthy for both `torghut` and `torghut-options`
with the promoted Torghut image digest
`sha256:b9156e2f5d9cb22f7ae57fa8c6dba273a8e47524eb551940beb11f0baade7173`. The new Torghut deployments
rolled out, promoted pods are ready with zero restarts, and service probes are green except the known
live-capital shadow gate. I am still holding #5412: it is conflict-free and green in CI on head
`df361911e250fa315002c776e8ac4a53dc781e69`, but it is a 3,165-line large diff with zero posted
reviews, and the latest current-head Codex review request returned the usage-limit blocker. That
remains a hard no-go until Codex review capacity is restored or a maintainer explicitly waives the
large-diff gate.

## Open PR enumeration

- #5412, `feat(torghut): add evidence epochs and shared live gate`, is the primary Torghut quant
  runtime PR. It is selected and held.
- #5649, `fix(torghut): unblock historical simulation proof setup`, appeared during this verification
  window. It was selected as a small unblocker PR, verified, and merged.
- #5651, `chore(torghut): promote image cfeb86f5`, was the automated Torghut image promotion for
  #5649. It was verified as part of the rollout gate after merge.
- #5646 and #5652 were prior audit refresh PRs. This final correction supersedes their pre-promotion
  rollout evidence with the final promoted-image state.
- #5594 is Jangar-scoped and outside the Torghut quant release gate.
- #5316 is an older automated release PR and was not selected for Torghut quant promotion work.

## Gate decisions

#5412 remains no-go for merge:

- `gh pr view 5412 --json additions,deletions,changedFiles` reports 3,138 additions, 27 deletions,
  and 20 files changed.
- GraphQL reports zero reviews and zero review threads.
- `mergeStateStatus=CLEAN`.
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

#5651 rollout was go after promotion:

- #5651 promoted source commit `cfeb86f5cd0d70a74b4d5ed4aecfb4123282a5c9` as image tag `cfeb86f5`.
- Promoted image digest:
  `sha256:b9156e2f5d9cb22f7ae57fa8c6dba273a8e47524eb551940beb11f0baade7173`.
- #5651 checks passed: argo-lint, kubeconform, Pyright, Bytecode + pytest + coverage, quality
  signals, semantic PR title, and semantic commits.
- Argo CD reconciled the promoted manifests and reached Synced/Healthy.

## PRs touched

- #5412: inspected, held, and left unmerged because the mandatory large-diff Codex review has not
  posted.
- #5649: selected, verified, and squash-merged to main at
  `cfeb86f5cd0d70a74b4d5ed4aecfb4123282a5c9`.
- #5651: automated Torghut image promotion, verified after merge at
  `9aeed1b66d50ec3cee095cf37e1503aebd017ee0`.
- #5646: audit PR verified and squash-merged at `bbfa3f8eb0a5511928b736c5b7c8f3cac0e51954`.
- #5652: audit refresh merged at `f109969bb1d4f60a037758545521068879f9d8ad`; this final correction
  resolves the evidence conflict and keeps the promoted-image rollout state.
- #5654: final audit correction PR on the required verify branch.

## Comments and conflicts

- #5412 has no merge conflicts, no posted reviews, and zero review threads.
- #5649 had no comments, no review requests, zero review threads, and a clean local merge-tree result.
- #5646 had no review threads and passed refreshed semantic checks before squash merge.
- #5654 conflicted with #5652 after main advanced; the conflict was resolved by preserving the latest
  #5651 promoted-image rollout evidence.
- The #5412 progress comment remains anchored with `<!-- codex:progress -->` and documents the
  Codex review usage-limit blocker.

## Merge outcomes

- #5649: merged by squash at `cfeb86f5cd0d70a74b4d5ed4aecfb4123282a5c9`.
- #5651: merged by squash at `9aeed1b66d50ec3cee095cf37e1503aebd017ee0`.
- #5646: merged by squash at `bbfa3f8eb0a5511928b736c5b7c8f3cac0e51954`.
- #5652: merged by squash at `f109969bb1d4f60a037758545521068879f9d8ad`.
- #5412: held, not merged.

## Validation

- PASS: `/usr/local/bin/codex-nats-soak` wrote `.codex-nats-context.json`; it fetched 25 recent
  general-channel messages and found no matching branch/run messages.
- PASS: `gh pr list -R proompteng/lab --state open --search "torghut in:title,body"` identified
  #5412 as the remaining open Torghut PR after #5649, #5651, #5646, and #5652 merged.
- PASS: `gh pr checks 5412 -R proompteng/lab` showed all visible #5412 checks passing or skipped.
- PASS: `gh pr checks 5649 -R proompteng/lab` showed all visible #5649 checks passing or skipped.
- PASS: `gh pr checks 5651 -R proompteng/lab` showed all visible #5651 checks passing or skipped.
- PASS: `gh pr checks 5646 -R proompteng/lab` showed all visible #5646 checks passing or skipped.
- PASS: `git merge-tree --write-tree origin/main refs/remotes/origin/pr/5649`.
- PASS: `git diff --check origin/main...origin/codex/swarm-torghut-quant`.
- PASS: `git diff --check origin/main...refs/remotes/origin/pr/5649`.
- PASS: `bunx oxfmt --check docs/torghut/rollouts/2026-05-06-torghut-quant-verify.md`.
- PASS: `git diff --check`.

## Deployment evidence

GitOps state after #5651 and the audit merges:

- `kubectl get applications.argoproj.io -n argocd torghut torghut-options -o custom-columns=...`
  reported:
  - `torghut`: `Synced`, `Healthy`, operation `Succeeded`, message
    `successfully synced (no more tasks)`.
  - `torghut-options`: `Synced`, `Healthy`, operation `Succeeded`, message
    `successfully synced (all tasks run)`.

Workload readiness:

- PASS: `kubectl rollout status -n torghut deployment/torghut-00234-deployment --timeout=60s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-sim-00315-deployment --timeout=60s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-options-catalog --timeout=60s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-options-enricher --timeout=60s`.
- `kubectl get pods -n torghut --field-selector=status.phase!=Running,status.phase!=Succeeded -o name`
  returned no resources.
- Current promoted pods are ready with zero restarts:
  - `torghut-00234-deployment-55bb9f798f-njb8x`: `2/2`, image digest
    `sha256:b9156e2f5d9cb22f7ae57fa8c6dba273a8e47524eb551940beb11f0baade7173`.
  - `torghut-sim-00315-deployment-76c75596c8-n2f7m`: `2/2`, same Torghut image digest.
  - `torghut-options-catalog-7cf7686cdc-fjddk`: `1/1`, same Torghut image digest.
  - `torghut-options-enricher-5898fb984d-4729c`: `1/1`, same Torghut image digest.

Runtime probes:

- PASS: `curl http://torghut.torghut.svc.cluster.local/healthz` returned HTTP 200.
- PASS: `curl http://torghut.torghut.svc.cluster.local/` returned HTTP 200 with version
  `v0.568.5-148-gcfeb86f5c` and commit `cfeb86f5cd0d70a74b4d5ed4aecfb4123282a5c9`.
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
  This is the intended business gate, not a failed promoted-image rollout.

Events and RBAC:

- Recent warning events during the promoted-image rollout included transient startup/readiness probe
  failures before the current pods became ready.
- Recurring ClickHouse `MultiplePodDisruptionBudgets` warnings remain residual cluster hygiene debt.
- A Flink status-update warning remained present, with the Flink job state still `RUNNING` in the
  event payload.
- The verifier service account can read Argo Applications, Deployments, Pods, Events, and service
  probes. It cannot directly mutate production and no direct production mutation was performed.

## Risk

- #5412 is the main release risk and must stay unmerged until Codex review capacity is restored and
  any resulting review threads are resolved, or a maintainer explicitly waives the large-diff gate.
- Live capital remains intentionally shadow-blocked by `simple_submit_disabled`; the healthy rollout
  does not imply live capital enablement.
- ClickHouse multiple-PDB warnings remain non-blocking cluster hygiene debt for this gate.

## Rollback path

- For the promoted #5649/#5651 rollout: open a GitOps PR reverting #5651, or reverting main from
  `c7c5b5e6a9f3c10831f41096a4464a6731d0ac9b` back before `9aeed1b66d50ec3cee095cf37e1503aebd017ee0`,
  then let Argo CD reconcile. Do not mutate production directly outside an emergency.
- Rollback triggers: Argo `torghut` or `torghut-options` becomes Degraded or stuck OutOfSync, rollout
  hooks fail, promoted workloads lose readiness, or runtime probes regress beyond the documented
  live-capital shadow gate.
- For #5412: no runtime rollback is required because it was not merged. Keep live promotion flags
  disabled while the review gate is blocked.

## Next action

Merge this final audit correction after checks pass. Keep #5412 open and blocked; re-request Codex
review only after review quota is restored, then resolve any threads, refresh against current main,
wait for all checks to pass, squash-merge, and repeat GitOps/workload/event verification.
