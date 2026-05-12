# Jangar Control-Plane Verify Gate - 2026-05-12

Release engineer: Marco Silva

## Governing Contract

- `docs/jangar/build-contract.md` requires the production flow to pass through `jangar-build-push`, `jangar-release`,
  Argo CD reconciliation, and `jangar-post-deploy-verify`.
- `services/jangar/README.md` defines `/ready` and `/api/agents/control-plane/status` as the runtime truth surface for
  execution trust, action budgets, failure-domain leases, and rollout safety.
- `docs/agents/runbooks.md` defines native workflow validation: `/ready` may stay 200 while degraded execution trust is
  visible, but material action budgets must keep deploy, merge, and capital actions held or blocked until evidence is
  repaired.

## Merge Gate

Open Jangar-scoped PR:

- #5889, `feat(jangar): add repair warrant exchange`, remains a no-go for merge.
- Current head: `733eb014338826630cdb342d137e13bb066d94c1`.
- GitHub merge state: `DIRTY` / `CONFLICTING` against current `main`.
- Diff size: 1,591 additions and 48 deletions across 18 files, 1,639 changed lines total.
- Conflict evidence: `git merge-tree --name-only origin/main origin/codex/swarm-jangar-control-plane` reports a content
  conflict in `docs/jangar/architecture-inventory.md`.
- Review gate: the diff exceeds the 1,000-line Codex review threshold. Multiple `@codex review` requests are present on
  the PR, but the Codex connector replied with the usage-limit message instead of posting a review. No review threads are
  open, and no Codex review is posted.

Decision: do not merge #5889. The smallest unblocker is to restore Codex review capacity, refresh the branch against
current `main`, rerun hosted checks, and merge only after the posted Codex review is clean.

## Merged Jangar Change Under Rollout

#6181, `fix(jangar): pause market context on provider capacity`, merged at 2026-05-12T15:26:55Z with merge commit
`c11a2f48b8e1c18a5456311e9a3134d8dfc0ad0d`.

PR-side checks were green or skipped as expected:

- `jangar-ci / lint-and-typecheck / run`: success
- `agents-ci / validate`: success
- `agents-ci / integration`: success
- semantic PR and commit checks: success

Post-merge promotion is blocked before a Jangar image artifact exists:

- `jangar-build-push` run `25744467297`: queued, job `build-and-push` not started.
- `Docker Build and Push` run `25744467307`: queued, job `changes` not started.
- `agents-ci` run `25744467360`: `validate` succeeded, `integration` still queued.
- GitHub Actions runners: 5 registered repo runners, all reported offline by the GitHub API.
- ARC evidence: runner pods are Running in namespace `arc`, but the listener is repeatedly terminating after TLS
  handshake timeouts to `broker.actions.githubusercontent.com`, and runner logs show timeouts to
  `pipelinesghubeus7.actions.githubusercontent.com`.

Decision: #6181 is not rolled out. The smallest unblocker is to restore GitHub Actions runner egress/connectivity, then
let the queued jobs drain and wait for GitOps promotion plus `jangar-post-deploy-verify`.

## Cluster Evidence

Current cluster state is healthy for the prior promoted image, not for #6181:

- Argo application `argocd/jangar`: `Synced` and `Healthy`.
- Argo application sync revision observed: `b9137f87f5e14cffab6f841cf5ead38724b95949`.
- Current Jangar image:
  `registry.ide-newton.ts.net/lab/jangar:05a6939b@sha256:8eabf940f5834ca5b834a5fb18ac7b9bfd3af4e768b3b3753f94ded39731771f`.
- Deployment `jangar/jangar`: 1 available replica, 1 updated replica, 1 desired replica.
- Pod `jangar-6679f79857-tsgp2`: both `app` and `docker` containers ready; app restart count 1.
- Service `jangar`: endpoint `10.244.5.174:8080`.
- `/health`: `{"status":"ok","service":"jangar"}`.
- `/ready`: HTTP 200 with status `ok`, execution trust `degraded`, and serving passport decision `allow`.
- `/api/agents/control-plane/status?namespace=agents`: execution trust `degraded`; workflow and job adapters
  `degraded` with message `workflow runtime not started`; Temporal adapter configured; failure-domain leases in
  `shadow` mode.
- Action budgets: `serve_readonly` and `dispatch_repair` allowed; `dispatch_normal` repair-only; `deploy_widen` and
  `merge_ready` held; Torghut paper/live capital budgets held or blocked.

Residual risk:

- Recent namespace events include transient `ImagePullBackOff` warnings for the current Jangar image at 2026-05-12
  15:58 UTC, but the current pod is ready and the service responds.
- Execution trust remains degraded, so the runtime correctly keeps deploy and merge actions held.
- Repository runner outage blocks promotion and any new PR CI.

## Rollback Path

If the currently deployed `05a6939b` image regresses, use GitOps rollback:

1. Open a rollback PR that reverts `argocd/applications/jangar/kustomization.yaml` and
   `argocd/applications/jangar/deployment.yaml` from promotion commit `ca0b360ed3a867f71fb5de4fe555a528cd263f7f`.
2. Restore the previous promoted image from #6154:
   `registry.ide-newton.ts.net/lab/jangar:0cbbd010@sha256:61a5dc4614e4ec320c77bb1bc92e7f2f2944f6c2b935565f979d66a517ebd97b`.
3. Let Argo CD reconcile the rollback PR merge and require workload readiness plus `/ready` evidence before closing the
   incident.

No direct production mutation was made from this workspace.

## Business Metric Evidence

The useful improvement in this pass is handoff evidence quality and ready-status truth:

- #5889 was kept out of production because it is conflict-dirty and blocked by a missing mandatory large-diff review.
- #6181 was not declared rolled out because the image build and promotion never started.
- Current cluster readiness was separated from latest-merge readiness: cluster is healthy on `05a6939b`; #6181 remains
  pending runner recovery.

The blocker preventing further improvement to `failed_agentrun_rate` and `pr_to_rollout_latency` is GitHub Actions runner
connectivity plus Codex review capacity for the large #5889 PR.
