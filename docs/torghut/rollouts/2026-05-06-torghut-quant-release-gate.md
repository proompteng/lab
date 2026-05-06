# Torghut quant release gate - 2026-05-06

## Decision

Go for the merged #5710/#5715 rollout. No-go remains in force for PR #5412,
`feat(torghut): add proof leases and evidence gates`.

#5710, `fix(torghut): use decision prices for simulation fills`, merged at
`d30d19d0f73b030ee7cac3b11e8d60a5564c427b`. #5715, `chore(torghut): promote image d30d19d0`,
promoted that code through GitOps at `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`. Required checks,
image build/push, Torghut CI, and post-deploy verification passed. Current Torghut child Argo
applications are Synced/Healthy, promoted workloads are ready, and service probes return HTTP 200.

#5412 is still held. GitHub reports #5412 as `MERGEABLE` and `CLEAN`, and all visible required checks
are passing at head `e64cf4f37e2738a772ef0dc75067533e73b36deb`. I did not squash-merge it because
the change is 4,211 additions and 28 deletions across 23 files. That exceeds the 1,000-line threshold,
and the required Codex review has not posted.

I refreshed the `@codex review` request at 2026-05-06T15:55Z. The connector returned the usage-limit
blocker again at 2026-05-06T15:56Z. The smallest unblocker is restored Codex review capacity, or an
explicit maintainer waiver of the large-diff review gate.

## PR Scope

Selected Torghut PRs:

- #5412, `feat(torghut): add proof leases and evidence gates`
  - Head branch: `codex/swarm-torghut-quant`
  - Head SHA: `e64cf4f37e2738a772ef0dc75067533e73b36deb`
  - Merge state: `MERGEABLE` / `CLEAN`
  - Diff size: 4,211 additions / 28 deletions
  - Blocking gate: missing Codex large-diff review
- #5709, `revert(torghut): rollback failed promotion bcf3779676087dc1ce687e62b2b192daf9ed4ee3`
  - Selected after #5701 post-deploy verification failed.
  - Merged by squash at `77fa3becfc30b9c3660fe1c5184cec5142beadc4`.
- #5710, `fix(torghut): use decision prices for simulation fills`
  - Selected after Torghut changed-line coverage failed.
  - Merged by squash at `d30d19d0f73b030ee7cac3b11e8d60a5564c427b`.
- #5715, `chore(torghut): promote image d30d19d0`
  - Selected as the automated GitOps promotion for #5710.
  - Merged by squash at `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`.

## Validation

GitHub checks passing on #5412:

- `Bytecode + pytest + coverage`
- `Pyright`
- `Quality signals (complexity + security)`
- `lint`
- `validate`
- `check_changed_files`
- `Validate PR title`
- `Lint commit messages`

#5709 checks and rollout:

- PASS: #5709 PR checks passed before merge: argo-lint, kubeconform, Semantic PR title, Semantic
  commits, Torghut Pyright, Torghut quality signals, and Torghut bytecode + pytest + coverage.
- PASS: `torghut-ci` run `25447015991` passed on merge commit
  `77fa3becfc30b9c3660fe1c5184cec5142beadc4`.
- PASS: `torghut-post-deploy-verify` run `25447015970` passed on merge commit
  `77fa3becfc30b9c3660fe1c5184cec5142beadc4`.

#5710 checks and promotion:

- PASS: #5710 PR checks passed after the coverage repair: Torghut Pyright, Torghut quality signals,
  Torghut bytecode + pytest + coverage, changed-files, Semantic PR title, and Semantic commit
  messages.
- PASS: `torghut-ci` run `25448139114` passed on merge commit
  `d30d19d0f73b030ee7cac3b11e8d60a5564c427b`.
- PASS: `torghut-build-push` run `25448134113` passed and produced image digest
  `sha256:c69a13b8bb4c081e7bc8518397e845433337a3f501c3e42a7cd6bf792de2528c`.
- PASS: #5715 PR checks passed after rerunning a transient GitHub API 504 in the
  `torghut-deploy-automerge` enable job.
- PASS: `torghut-ci` run `25448616646` passed on promotion merge commit
  `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`.
- PASS: `torghut-post-deploy-verify` run `25448616455` passed on promotion merge commit
  `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`.

## Current Rollout Evidence

No #5412 rollout occurred because #5412 was not merged.

Current production state is healthy for the #5710/#5715 rollout:

- Argo CD applications:
  - `torghut`: Synced / Healthy at `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`
  - `torghut-options`: Synced / Healthy at `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`
  - `symphony-torghut`: Synced / Healthy at `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`
  - `root`: OutOfSync / Healthy, residual ApplicationSet drift
- `kubectl get pods -n torghut --field-selector=status.phase!=Running,status.phase!=Succeeded -o wide`
  returned no resources.
- Active desired-replica deployments reported ready and available replicas at desired count.
- Active Torghut runtime pods are Running and ready with zero restarts:
  - `torghut-00240-deployment-5b97b65696-v7hfb`
  - `torghut-sim-00336-deployment-5db9bfdf66-qwfdp`
  - `torghut-options-catalog-597546479-vj79w`
  - `torghut-options-enricher-74b7dcf4b8-p656h`
- Active Torghut image digest:
  `sha256:c69a13b8bb4c081e7bc8518397e845433337a3f501c3e42a7cd6bf792de2528c`.
- Runtime metadata reports `TORGHUT_VERSION=v0.568.5-213-gd30d19d0f` and
  `TORGHUT_COMMIT=d30d19d0f73b030ee7cac3b11e8d60a5564c427b`.
- Runtime probes returned HTTP 200 for:
  - `http://torghut.torghut.svc.cluster.local/healthz`
  - `http://torghut.torghut.svc.cluster.local/trading/status`
  - `http://torghut-sim.torghut.svc.cluster.local/readyz`
  - `http://torghut-options-catalog.torghut.svc.cluster.local/healthz`
  - `http://torghut-options-enricher.torghut.svc.cluster.local/readyz`
- `live_submission_gate.allowed=false`, `reason=simple_submit_disabled`, and `capital_stage=shadow`;
  this is the expected live-capital block, not a rollout failure.

Recent event risks:

- The #5715 rollout emitted transient startup/readiness warnings for newly rolled pods before they
  became ready.
- ClickHouse pods still emit `MultiplePodDisruptionBudgets` warnings. This is residual cluster
  hygiene debt, not a blocker for the current Torghut runtime health gate.
- Older #5709 rollback events include a failed teardown-clean AnalysisRun; #5715 post-deploy
  verification passed after the later rollout and opened no rollback PR.

## Rollback

For #5710/#5715, open a GitOps PR reverting `cf7977855abc6c7f37b56e6b4705288a67ce9f7b`, or revert the
12 #5715 image-reference changes back to the previous healthy digest and let Argo CD reconcile. Keep
live-promotion flags disabled during rollback.

For #5412, no rollback is needed because production is unchanged by #5412.

Current live config remains conservative:

- `TRADING_SIMPLE_SUBMIT_ENABLED=false`
- `TRADING_AUTONOMY_ENABLED=false`
- `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`

## Next Checkpoint

Hold #5412 until Codex review capacity is available and the required review posts. After all review
threads are resolved, refresh against current `main`, rerun required checks, squash-merge only with all
required checks green, and then repeat Argo sync, workload readiness, probe, and event verification.
