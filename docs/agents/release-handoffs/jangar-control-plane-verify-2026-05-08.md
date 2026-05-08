# Jangar Control Plane Release Handoff - 2026-05-08

Owner update message:

Merge gate remains closed. #5889 is clean and all hosted checks are green at head
`84f88bb2cd9b00f50c14a75a56faba4ed32310e4`, with zero review threads, but it is 1,639 changed lines and no Codex
review has posted because the connector still returns the account usage-limit blocker. #5412 is also clean and green at
head `33c711fe3ed5ceb868d44bc516b893948c41b37a`, but it is Torghut-owned and 8,940 changed lines, so it is held by the
same Codex review gate. Current GitOps baseline is Synced/Healthy and workloads are ready; the smallest blocker
preventing the Jangar control-plane metric improvement is restored Codex review capacity for the large PRs.

## PRs Touched

- #5889 `feat(jangar): add repair warrant exchange`
  - Progress comment refreshed:
    https://github.com/proompteng/lab/pull/5889#issuecomment-4398288855.
  - Merge decision: no-go. The PR is clean and green, but exceeds the mandatory large-diff Codex-review gate and no
    Codex review has posted.
- #5412 `feat(torghut): add profit escrow runtime projections`
  - Progress comment refreshed:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4404049669.
  - Merge decision: no-go for this Jangar pass. The PR is clean and green now, but is Torghut-owned and also lacks the
    required Codex review for a large diff.

## Comments And Conflicts

- No code conflicts were repaired in this pass; GitHub reports both PRs `MERGEABLE` and `CLEAN`.
- #5889: GraphQL reports zero review threads and zero posted reviews. Latest Codex connector response:
  https://github.com/proompteng/lab/pull/5889#issuecomment-4405385768.
- #5412: GraphQL reports zero review threads and zero posted reviews. Latest Codex connector response:
  https://github.com/proompteng/lab/pull/5412#issuecomment-4405416327.

## Checks

- #5889 hosted checks pass or skip intentionally:
  `CI / check_changed_files`, semantic title and commit checks, `agents-ci / validate`,
  `agents-ci / integration`, and `jangar-ci / lint-and-typecheck / run`.
- #5412 hosted checks pass or skip intentionally:
  `CI / check_changed_files`, semantic title and commit checks, `agents-ci / validate`,
  `agents-ci / integration`, `jangar-ci / lint-and-typecheck / run`, and observed `torghut-ci` pyright, pytest,
  coverage, migration guard, and quality-signal jobs.

## Deployment Evidence

- Argo: `argocd/jangar`, `argocd/agents`, `argocd/symphony-jangar`, and `argocd/agents-ci` are `Synced`, `Healthy`,
  operation `Succeeded`, revision `a1fcc37625ee1a7104071c9dbcb0a386bb7868b2`.
- Rollouts: `deployment/jangar`, `deployment/agents`, `deployment/agents-controllers`, and
  `deployment/symphony-jangar` all report successful rollout.
- Readiness: `jangar` is `2/2`, `agents` is `1/1`, `agents-controllers` is `2/2`, and `symphony-jangar` is `1/1`.
- Service health: Jangar `/health` returned `status=ok`; Symphony `/readyz` returned `ok=true`.
- Control-plane status: controller authority is healthy, database is connected, and migration consistency is healthy
  with 28 registered and 28 applied migrations.

## Metrics And Risk

- `failed_agentrun_rate`: Jangar control-plane AgentRuns created since 2026-05-08T00:00Z show 34 total, 33 succeeded,
  1 running, and 0 failed. Historical matching AgentRuns show 224 total, 216 succeeded, 1 running, and 7 failed.
- `ready_status_truth`: Argo, rollout status, pods, endpoints, service health, controller authority, database health,
  and image digests agree for the deployed baseline.
- `manual_intervention_count`: zero production workload mutations from this shell.
- `pr_to_rollout_latency`: no improvement recorded because no runtime PR merged.
- Risk: the release value remains blocked by an external Codex review-capacity condition, not by conflicts, tests, or
  rollout health.

## Rollback Path

- #5889 and #5412 have no runtime rollback from this pass because neither merged.
- For the currently deployed Jangar image, use a normal GitOps revert PR for the `03eea88e` promotion to restore the
  previous promoted image, then revert the underlying runtime PR if image rollback does not clear the issue.
- No direct production mutation should be used for normal rollback.

## Next Action

Restore Codex code-review capacity and get current-head Codex reviews posted for #5889 and #5412, then recheck
mergeability, required checks, review threads, and rollout health before any squash merge.
