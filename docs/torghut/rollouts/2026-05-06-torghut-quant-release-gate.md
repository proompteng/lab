# Torghut quant release gate - 2026-05-06

## Decision

No-go for PR #5412, `feat(torghut): add evidence epochs and shared live gate`.

GitHub reports the PR as `MERGEABLE` and `CLEAN`, and all visible CI checks are passing at head
`c6147b522832ee04246f35451c88be509f0c8846`. I did not squash-merge because the change is
3,138 additions and 27 deletions. That exceeds the 1,000-line review threshold, and the required
Codex review has not posted.

The only `@codex review` responses on the PR are usage-limit failures from `chatgpt-codex-connector`.
The smallest unblocker is restored Codex review capacity, or an approved alternate path that posts the
required large-diff Codex review on #5412.

## PR Scope

Selected Torghut PR:

- #5412, `feat(torghut): add evidence epochs and shared live gate`
  - Head branch: `codex/swarm-torghut-quant`
  - Head SHA: `c6147b522832ee04246f35451c88be509f0c8846`
  - Merge state: `MERGEABLE` / `CLEAN`
  - Diff size: 3,138 additions / 27 deletions
  - Blocking gate: missing Codex large-diff review

Open PRs not selected for the Torghut gate:

- #5594 is Jangar control-plane scope.
- #5501, #5497, #5482, #5477, #5470, and #5316 are one-line automated release PRs for other
  application paths (`app`, `docs`, `bumba`).

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

Implementation-lane local evidence from the refreshed head:

- Focused Torghut regressions: 239 passed
- Full Torghut pytest: 1903 passed
- Total coverage: 76.27%, above the 70% gate
- Changed-line coverage: 99.49%
- All three Torghut pyright profiles passed
- Argo lint and diff whitespace passed

## Current Rollout Evidence

No #5412 rollout occurred because #5412 was not merged.

Current production state is healthy for the already-deployed Torghut surfaces:

- Argo CD applications:
  - `torghut`: Synced / Healthy at `0bba2aa85e7602ac6b2d5cd29536d6a883916f6d`
  - `torghut-options`: Synced / Healthy at `0bba2aa85e7602ac6b2d5cd29536d6a883916f6d`
  - `symphony-torghut`: Synced / Healthy at `591ffa10f6678ad780d6df4749311af1a4dc9573`
- `kubectl get pods -n torghut --field-selector=status.phase!=Running,status.phase!=Succeeded`
  returned no resources.
- Active Torghut pods were Running with ready containers, including `torghut-00228-deployment`,
  `torghut-sim-00309-deployment`, `torghut-options-catalog`, `torghut-options-enricher`,
  `torghut-options-ta`, `torghut-ws`, and the TA task managers.
- Deployments with nonzero desired replicas reported ready and available replicas at desired count.

Recent event risks:

- Startup and readiness probe warnings appeared during the rollout window, then recovered.
- `flinkdeployment/torghut-options-ta` emitted an external status modification warning while the
  latest status still reported `state=RUNNING`, `lifecycleState=STABLE`, and
  `jobManagerDeploymentStatus=READY`.
- ClickHouse pods emitted warnings about matching multiple PodDisruptionBudgets. This is residual
  rollout risk, not a blocker for the no-merge decision.
- The verifier service account could not list Knative `services.serving.knative.dev` or
  `revisions.serving.knative.dev`, so readiness evidence used Argo application health, Deployments,
  Pods, Jobs, and events.

## Rollback

Before #5412 merges, no rollback is needed because production is unchanged.

If #5412 is merged later and causes trading-status, readiness, order-submission gating, or evidence
receipt regressions, revert the #5412 squash commit on `main` via PR. If an image/GitOps promotion has
already rolled out, revert the corresponding `argocd/applications/torghut` image digest to the previous
healthy digest and let Argo CD reconcile. Keep live-promotion flags disabled during rollback.

Current live config is conservative:

- `TRADING_SIMPLE_SUBMIT_ENABLED=false`
- `TRADING_AUTONOMY_ENABLED=false`
- `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`

## Next Checkpoint

Hold #5412 until Codex review capacity is available and the required review posts. After all review
threads are resolved, refresh against current `main` if needed, rerun required checks on the final head,
squash-merge only with all required checks green, and then verify Argo sync, workload readiness, and
warning/error events for the merged commit.
