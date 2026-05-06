# Torghut quant verifier release gate - 2026-05-06

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-06T16:53Z

## Owner update message

Torghut release state is go for the merged #5710/#5715 path and no-go for #5412.

#5710 merged as `d30d19d0f73b030ee7cac3b11e8d60a5564c427b`, and #5715 promoted that image through
GitOps as `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`. Torghut CI, build/push, promotion PR checks,
and post-deploy verification all passed. Argo child applications are Synced/Healthy at `cf7977855`,
the active Torghut pods are ready on image digest
`sha256:c69a13b8bb4c081e7bc8518397e845433337a3f501c3e42a7cd6bf792de2528c`, and service probes return
HTTP 200.

#5412 remains held. It is clean and green on head `e64cf4f37e2738a772ef0dc75067533e73b36deb`, but it
is a 4,239-line diff and the required Codex review has not posted. The latest Codex review request
returned the connector usage-limit blocker, so the smallest unblocker is restored Codex review
capacity or an explicit maintainer waiver of the large-diff review gate.

## Open PR enumeration

- #5412, `feat(torghut): add proof leases and evidence gates`, is the remaining open Torghut quant
  runtime PR. It was selected for release review and held.
- #5709, `revert(torghut): rollback failed promotion bcf3779676087dc1ce687e62b2b192daf9ed4ee3`,
  was selected after #5701 post-deploy verification failed. It was verified and merged.
- #5710, `fix(torghut): use decision prices for simulation fills`, appeared during this gate with a
  Torghut changed-line coverage failure. It was selected as a small unblocker, repaired by the PR
  owner, verified, and merged.
- #5715, `chore(torghut): promote image d30d19d0`, was the automated GitOps promotion for #5710. It
  was selected, verified, and merged.
- Non-Torghut open PRs, including Jangar release/control-plane work, were not selected.

## Gate decisions

#5412 remains no-go for merge:

- GitHub reports `mergeable=MERGEABLE` and `mergeStateStatus=CLEAN` on the observed head.
- Current head: `e64cf4f37e2738a772ef0dc75067533e73b36deb`.
- Size: 4,211 additions and 28 deletions across 23 files.
- Required visible checks are pass or intentionally skipped: Torghut Pyright, Torghut quality
  signals, Torghut bytecode + pytest + coverage, argo-lint, kubeconform, changed-files, Semantic PR
  title, and Semantic commit messages.
- Reviews: zero posted reviews and zero review threads.
- Latest Codex review request: https://github.com/proompteng/lab/pull/5412#issuecomment-4389826534.
- Latest connector blocker: https://github.com/proompteng/lab/pull/5412#issuecomment-4389828233.

#5709 was go for merge:

- Size: 10 additions and 10 deletions across 4 GitOps manifests.
- GitHub reported `mergeable=MERGEABLE` and `mergeStateStatus=CLEAN`.
- Review threads: zero.
- Required PR checks passed before merge: argo-lint, kubeconform, Semantic PR title, Semantic commit
  messages, Torghut Pyright, Torghut quality signals, and Torghut bytecode + pytest + coverage.
- Squash merge commit: `77fa3becfc30b9c3660fe1c5184cec5142beadc4`.

#5710 was go for merge:

- Size after repair: 315 additions and 9 deletions across 4 Torghut files, below the large-diff Codex
  review gate.
- Initial blocker: `Bytecode + pytest + coverage` failed changed-line coverage at 66.04%.
- Repair: the PR head was updated to `3c047e14b95a735ceae53e84233240f70d73d98d` with regression
  coverage for decision-price simulation fill paths.
- Required PR checks passed: Torghut Pyright, Torghut quality signals, Torghut bytecode + pytest +
  coverage, changed-files, Semantic PR title, and Semantic commit messages.
- Review threads: zero.
- Squash merge commit: `d30d19d0f73b030ee7cac3b11e8d60a5564c427b`.

#5715 was go for merge:

- Size: 22 additions and 22 deletions across 12 GitOps manifests.
- Required PR checks passed: argo-lint, kubeconform, Torghut Pyright, Torghut quality signals,
  Torghut bytecode + pytest + coverage, Semantic PR title, and Semantic commit messages.
- A transient `torghut-deploy-automerge` GitHub API 504 was rerun and passed before merge.
- Review threads: zero.
- Squash merge commit: `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`.

## PRs touched

- #5412: inspected, progress comment refreshed, Codex review re-requested, and held unmerged.
- #5709: PR body corrected to the repo template, checks verified, and squash-merged.
- #5710: failing coverage gate investigated, anchored progress comment updated, checks verified after
  repair, and squash-merged.
- #5715: PR body corrected to the repo template, anchored progress comment added, transient failed
  automerge gate rerun, checks verified, and squash-merged.

## Comments and conflicts

- #5412 progress comment remains anchored with `<!-- codex:progress -->` and records the Codex review
  usage-limit blocker plus current rollout evidence.
- #5710 progress comment remains anchored and records the merge gate evidence.
- #5715 progress comment remains anchored and records the promotion merge gate evidence.
- #5412, #5709, #5710, and #5715 had no unresolved review threads.
- #5709 and #5715 PR bodies were updated from the repository template so the audit trail reflects the
  actual merge decision and validation.
- #5710 remote branch advanced while local testing was in progress; I rebased the local worktree and
  dropped the duplicate local coverage commit, keeping the PR owner updated head as source of truth.

## Merge outcomes

- #5412: held, not merged.
- #5709: merged by squash at `77fa3becfc30b9c3660fe1c5184cec5142beadc4`.
- #5710: merged by squash at `d30d19d0f73b030ee7cac3b11e8d60a5564c427b`.
- #5715: merged by squash at `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`.

## Validation

- PASS: `/usr/local/bin/codex-nats-soak` refreshed `.codex-nats-context.json`; it fetched recent
  general-channel context and found no matching messages.
- PASS: `gh pr checks 5412 -R proompteng/lab --watch=false` showed all visible #5412 checks passing
  or skipped.
- PASS: `gh pr checks 5709 -R proompteng/lab --watch` completed with all visible #5709 checks
  passing or skipped.
- PASS: `gh pr checks 5710 -R proompteng/lab --watch --interval 30`.
- PASS: `gh run watch 25448139114 -R proompteng/lab --interval 30 --exit-status`.
- PASS: `gh run watch 25448134113 -R proompteng/lab --interval 30 --exit-status`.
- PASS: `gh pr checks 5715 -R proompteng/lab --watch --interval 30`.
- PASS: `gh run rerun 25448309124 -R proompteng/lab --failed`, followed by a passing rerun.
- PASS: `gh run watch 25448616646 -R proompteng/lab --interval 30 --exit-status`.
- PASS: `gh run watch 25448616455 -R proompteng/lab --interval 30 --exit-status`.

Local #5710 repair validation before the remote branch advanced:

- PASS: `uv lock --check`.
- PASS: `uv sync --frozen --extra dev`.
- PASS: `uv run --frozen python -m compileall app`.
- PASS: `uv run --frozen ruff check app tests scripts migrations`.
- PASS: `uv run --frozen python scripts/check_migration_graph.py`.
- PASS: `uv run --frozen pyright --project pyrightconfig.json`.
- PASS: `uv run --frozen pyright --project pyrightconfig.alpha.json`.
- PASS: `uv run --frozen pyright --project pyrightconfig.scripts.json`.
- PASS: `uv run --frozen pytest -n auto --dist=worksteal --cov --cov-branch --cov-report=term-missing --cov-report=xml --cov-fail-under=70`.
- PASS: `GITHUB_BASE_REF=main GITHUB_EVENT_NAME=pull_request uv run --frozen python scripts/check_diff_coverage.py --coverage-xml coverage.xml --threshold 90`.
- PASS: `uv run --frozen ruff check app scripts migrations --select C901 --statistics --exit-zero`.
- PASS: `uv run --frozen ruff check app scripts migrations --select S --statistics --exit-zero`.

## Deployment evidence

Post-merge workflow evidence:

- `torghut-ci` run `25447015991` passed on `77fa3becfc30b9c3660fe1c5184cec5142beadc4`.
- `torghut-post-deploy-verify` run `25447015970` passed on
  `77fa3becfc30b9c3660fe1c5184cec5142beadc4`.
- `torghut-build-push` run `25448134113` passed on `d30d19d0f73b030ee7cac3b11e8d60a5564c427b`.
- `torghut-ci` run `25448139114` passed on `d30d19d0f73b030ee7cac3b11e8d60a5564c427b`.
- `torghut-ci` run `25448616646` passed on `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`.
- `torghut-post-deploy-verify` run `25448616455` passed on
  `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`; rollback steps were skipped.

GitOps state after #5715:

- `torghut`: Synced / Healthy at revision `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`.
- `torghut-options`: Synced / Healthy at revision `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`.
- `symphony-torghut`: Synced / Healthy at revision `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`.
- `root`: OutOfSync / Healthy at revision `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`. This is residual
  root ApplicationSet drift; Torghut child apps are healthy.
- `torghut` operation sync result: `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`, `Succeeded`,
  `successfully synced (no more tasks)`.
- `torghut-options` operation sync result: `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`, `Succeeded`,
  `successfully synced (all tasks run)`.

Workload readiness:

- All deployments with desired replicas in namespace `torghut` reported ready and available replicas
  equal to desired replicas.
- `kubectl get pods -n torghut --field-selector=status.phase!=Running,status.phase!=Succeeded -o wide`
  returned no resources.
- Current promoted pods are ready with zero restarts:
  - `torghut-00240-deployment-5b97b65696-v7hfb`, image digest
    `sha256:c69a13b8bb4c081e7bc8518397e845433337a3f501c3e42a7cd6bf792de2528c`.
  - `torghut-sim-00336-deployment-5db9bfdf66-qwfdp`, same Torghut image digest.
  - `torghut-options-catalog-597546479-vj79w`, same Torghut image digest.
  - `torghut-options-enricher-74b7dcf4b8-p656h`, same Torghut image digest.
- Runtime metadata on the active Torghut deployments reports
  `TORGHUT_VERSION=v0.568.5-213-gd30d19d0f` and
  `TORGHUT_COMMIT=d30d19d0f73b030ee7cac3b11e8d60a5564c427b`.
- Runtime probes passed:
  - `curl http://torghut.torghut.svc.cluster.local/healthz` returned HTTP 200.
  - `curl http://torghut.torghut.svc.cluster.local/trading/status` returned HTTP 200 with
    `build.commit=d30d19d0f73b030ee7cac3b11e8d60a5564c427b`,
    `active_revision=torghut-00240`, and `live_submission_gate.allowed=false`.
  - `curl http://torghut-sim.torghut.svc.cluster.local/readyz` returned HTTP 200.
  - `curl http://torghut-options-catalog.torghut.svc.cluster.local/healthz` returned HTTP 200.
  - `curl http://torghut-options-enricher.torghut.svc.cluster.local/readyz` returned HTTP 200.

Recent event risks:

- The #5715 rollout emitted transient startup/readiness probe warnings for the new Torghut,
  Torghut-sim, options catalog, and options enricher pods before they became ready.
- One `torghut-ws-options` readiness warning also appeared during the rollout window; the current pod
  is Running and ready with zero restarts.
- Older #5709 rollback events still include a failed `torghut-sim` teardown-clean AnalysisRun with
  `BackoffLimitExceeded`; the later #5715 post-deploy verifier passed and no rollback PR was opened.
- ClickHouse pods still emit `MultiplePodDisruptionBudgets` warnings. This is residual cluster
  hygiene debt, not a blocker for the current Torghut runtime health gate.

## Risk

- #5412 remains the main release risk and must stay unmerged until Codex review capacity is restored
  and the required large-diff review posts, with all resulting threads resolved, or a maintainer
  explicitly waives the large-diff gate.
- Root Argo application drift remains a GitOps hygiene risk. It did not block the Torghut child app
  health gate, but it should be cleared by an operator with ApplicationSet/root sync access.
- Live capital remains intentionally shadow-blocked by `simple_submit_disabled`; the healthy rollout
  does not imply live capital enablement.
- The service account can read Argo applications, deployments, pods, events, and probes, but cannot
  list Knative `services.serving.knative.dev` directly. KService state was verified through Argo
  resource health plus live service probes.

## Rollback path

- For #5710/#5715: open a GitOps PR reverting `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`, or reverting
  the 12 image-reference changes from #5715 back to the previous healthy digest, then let Argo CD
  reconcile. Do not mutate production directly outside an emergency.
- Rollback triggers: `torghut` or `torghut-options` becomes Degraded or stuck OutOfSync, the
  post-deploy verification workflow fails, active Torghut pods lose readiness, or runtime probes
  regress beyond the documented live-capital shadow gate.
- #5709 is the rollback for failed #5701. If that rollback path regresses independently, open a GitOps
  PR reverting `77fa3becfc30b9c3660fe1c5184cec5142beadc4`, then let Argo CD reconcile.
- For #5412: no runtime rollback is required because it was not merged.

## Next action

Keep #5412 open and blocked. The smallest unblocker is restored Codex review capacity, or an explicit
maintainer waiver of the large-diff review gate. After the review posts, resolve any threads, refresh
against current `main`, wait for all required checks, squash-merge, and repeat GitOps/workload/event
verification.
