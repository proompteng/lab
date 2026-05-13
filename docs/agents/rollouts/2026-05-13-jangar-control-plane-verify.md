# Jangar control-plane release verification - 2026-05-13

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane-verify`
Release engineer: Marco Silva

## Owner update message

Rollout state is green for the selected Jangar control-plane release lane, with one runtime gate held for evidence.
I moved or verified the Jangar lane through #6363, #6367, #6378, and #6373 after the earlier #6324, #6330, #6339,
#6343, and #6349 batch. The latest deployed Jangar image is `45710e0b`: `deployment/jangar` and
`deployment/agents-controllers` run digest `sha256:1348bdb0571ee61c3c3005186261a422f4bc754bc19380f842577a9e694950c8`,
and `deployment/agents` runs control-plane digest
`sha256:533c8be4f98731a49bcf50039559ff2b5eae712280ef074b84711a2824d89cdf`.

The GitOps and workload rollout gate is green: Argo `jangar` and `agents` are Synced/Healthy, the three workloads are
available, `jangar /health` returns 200, and the post-deploy verifier for #6378 passed. The business metric that
improved is `ready_status_truth`, with supporting progress on `pr_to_rollout_latency` and
`handoff_evidence_quality`. The remaining blocker is not a deployment failure: a pre-existing implement AgentRun on
the older `5d89ac24` image was evicted for node ephemeral-storage pressure and froze the swarm until
2026-05-13T09:20:50.975Z, so material actions remain held while `serve_readonly` and `torghut_observe` stay allowed.

## Governing requirements

- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`: verify stages must merge only green PRs and
  prove Argo sync, workload readiness, and service health after rollout.
- `docs/agents/designs/129-jangar-consumer-evidence-leases-and-readiness-decoupling-2026-05-06.md`: governs #6324.
- `docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md`: governs #6330 and #6363.
- `docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`: governs #6339.
- `docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`: governs #6343.
- `docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md` and
  `docs/agents/designs/121-jangar-material-action-repair-clearing-lane-and-profit-proof-ledger-2026-05-06.md`:
  govern #6349.
- `docs/agents/designs/188-jangar-evidence-pressure-ledger-and-watch-backoff-governor-2026-05-13.md`: governs #6373.

## PRs touched

- #6324 `feat(jangar): add consumer evidence leases`
  - Fixed blockers: stale architecture inventory, rebase conflicts, and the Jangar module-size violation.
  - Merge outcome: merged at 2026-05-13T04:51:12Z as `6596b581321ab05168ed663a506e10e3893043d7`.
  - Promotion: #6335 `chore(jangar): promote image 6596b581`, post-deploy verifier `25779478472` passed.
- #6330 `feat(jangar): add stage credit ledger read model`
  - Fixed blockers: rebased onto #6324/main and preserved the consumer-evidence status helper imports.
  - Merge outcome: merged at 2026-05-13T05:11:23Z as `97a20bc4f6d2b6d6198372870795ad8ddce54a74`.
  - Promotion: #6342 `chore(jangar): promote image 97a20bc4`, post-deploy verifier `25780107631` passed.
- #6339 `feat(jangar): add source-serving verdict status`
  - Selected because it surfaced source-serving allow/hold/block readiness truth.
  - Merge outcome: merged at 2026-05-13T05:41:19Z as `99063cb4c14e0c22633f6d2a63391ca59ee6a6b3`.
  - Promotion: #6347 `chore(jangar): promote image 99063cb4`, post-deploy verifier `25781202876` passed.
- #6343 `feat(jangar): admit settled torghut repair lots`
  - Selected because source-serving verdicts named missing repair-bid settlement evidence.
  - Merge outcome: merged at 2026-05-13T06:04:51Z as `f18b66fdbc4e55bc2ef7177fc17fd86ea8a491b2`.
  - Promotion: #6350 `chore(jangar): promote image f18b66fd`, post-deploy verifier `25782031603` passed.
- #6349 `fix(jangar): preserve controller heartbeat witnesses`
  - Selected because live status still showed controller heartbeat truth as a runtime blocker.
  - Merge outcome: merged at 2026-05-13T06:28:30Z as `5d89ac24819d84632873caf046cd0a1ff111db95`.
  - Promotion: #6355 `chore(jangar): promote image 5d89ac24`, post-deploy verifier `25782868775` passed.
- #6363 `fix(jangar): stamp stage credit launch evidence`
  - Selected because the active controller `/ready` path was degraded by stale verify-stage evidence even though
    workloads were serving.
  - Checks before merge: `agents-ci / validate`, `agents-ci / integration`, `jangar-ci / lint-and-typecheck`,
    `CI / check_changed_files`, semantic commits, and semantic PR title all passed.
  - Merge outcome: merged at 2026-05-13T08:04:46Z as `fdc164d70ae04f1d7defc8496c1a233685a3d0c2`.
  - Mainline build: `jangar-build-push` run `25786518304` passed and produced image tag `fdc164d7`.
  - Promotion: #6365 `chore(jangar): promote image fdc164d7`, merged as
    `1feb3fd8b727185dd014ec0f38481d1f2fb4be4b`; post-deploy verifier `25786999729` passed.
- #6367 `fix(jangar): credit terminal swarm stage completions`
  - Selected because terminal run freshness accounting directly affects failed-run and ready-status truth.
  - PR checks before merge: `agents-ci / validate`, `agents-ci / integration`, `jangar-ci / lint-and-typecheck`,
    `CI / check_changed_files`, semantic commits, and semantic PR title all passed.
  - Merge outcome: merged at 2026-05-13T08:32:20Z as `45710e0bb070144dc8f7c25bd855221ca3c4e02a`.
  - Mainline validation: `jangar-build-push` run `25787811627` passed and produced image tag `45710e0b`;
    `agents-ci` run `25787811625` passed.
  - Promotion: #6378 `chore(jangar): promote image 45710e0b`, merged as
    `270bb6740ca9b38d0d38de1020c73719b78bbac0`; `jangar-ci / lint-and-typecheck`, `argo-lint`, `kubeconform`,
    semantic checks, and post-deploy verifier `25788838577` all passed.
- #6373 `docs(jangar): define evidence pressure ledger`
  - Selected because it records the evidence-pressure and watch-backoff governance needed to reduce failed AgentRuns.
  - Checks before merge: `agents-ci / validate`, `agents-ci / integration`, `jangar-ci / lint-and-typecheck`,
    `CI / check_changed_files`, semantic commits, and semantic PR title all passed.
  - Merge outcome: merged at 2026-05-13T09:00:24Z as `3394723b5f07dfc9ff807f5ff29d112eaf6f8c20`.
- Current residual Jangar PR blocker: #6372 `fix(jangar): consume torghut typed evidence` remains open and not
  selected for merge because it is conflict-blocked. `git merge-tree origin/main origin/pr-6372` reports a content
  conflict in `docs/torghut/design-system/v6/index.md`.

## Comments and conflicts

- Progress comments were kept current with `services/jangar/scripts/codex/codex-progress-comment.ts` on selected PRs,
  including #6363 and this audit PR.
- #6324 and #6330 required real conflict/module-size fixes before merge.
- #6363, #6367, and #6373 had no blocking review threads when selected and had green PR checks before merge.
- #6365 and #6378 promotion PRs were generated by release automation. In both cases the deploy automerge path merged
  before the non-required `jangar-ci / lint-and-typecheck` check completed; those checks later passed, and each
  post-deploy verifier passed. This is a residual branch-protection risk to track separately.
- No direct production mutation was made from this shell. Promotion was via merged PRs and GitOps reconciliation.

## Deployment evidence

- Final Jangar promotion:
  - #6378 merged at 2026-05-13T08:53:45Z as `270bb6740ca9b38d0d38de1020c73719b78bbac0`.
  - #6378 `jangar-ci / lint-and-typecheck` passed at 2026-05-13T08:55:53Z.
  - `jangar-post-deploy-verify` run `25788838577` passed from 2026-05-13T08:53:52Z to 08:56:35Z.
- Argo state after the rollout:
  - `agents`: Synced, Healthy, operation Succeeded.
  - `jangar`: Synced, Healthy, operation Succeeded.
- Workload state:
  - `deployment/jangar -n jangar`: 1/1 available on
    `registry.ide-newton.ts.net/lab/jangar:45710e0b@sha256:1348bdb0571ee61c3c3005186261a422f4bc754bc19380f842577a9e694950c8`.
  - `deployment/agents -n agents`: 1/1 available on
    `registry.ide-newton.ts.net/lab/jangar-control-plane:45710e0b@sha256:533c8be4f98731a49bcf50039559ff2b5eae712280ef074b84711a2824d89cdf`.
  - `deployment/agents-controllers -n agents`: 2/2 available on
    `registry.ide-newton.ts.net/lab/jangar:45710e0b@sha256:1348bdb0571ee61c3c3005186261a422f4bc754bc19380f842577a9e694950c8`.
- Service health:
  - `http://jangar.jangar.svc.cluster.local/health`: HTTP 200, `status=ok`.
  - `http://agents.agents.svc.cluster.local/ready`: HTTP 200, with runtime status `degraded` because execution trust
    is blocked by the current swarm freeze.
- Runtime status after rollout:
  - Swarm phase: `Frozen`, `Ready=False`, frozen until `2026-05-13T09:20:50.975Z`.
  - Freeze evidence: `jangar-control-plane-implement-sched-8b575` failed with `BackoffLimitExceeded`.
  - Pod evidence: attempt 2 ran old image `5d89ac24` and was evicted because node ephemeral storage was low; the pod
    used 3925420Ki ephemeral storage with no request.
  - The failure is a runtime capacity/runner resource blocker, not a failed GitOps rollout of `45710e0b`.
- Events:
  - Recent warnings are rollout-time readiness probe failures on old or starting pods and the old implement-run
    eviction. Current Jangar and agents deployments are available.

## Metrics and value gates

- `failed_agentrun_rate`: no Jangar AgentRun created after #6363 merged has failed. Counting by finish time, one
  pre-existing implement run created at 2026-05-13T07:00:05Z failed at 2026-05-13T08:56:46.964Z because the old
  runner pod was evicted for node ephemeral-storage pressure.
- `pr_to_rollout_latency`: #6367 merged at 2026-05-13T08:32:20Z and #6378 post-deploy verification completed at
  2026-05-13T08:56:35Z, for about 24m15s from source merge to verified rollout. #6363 took about 15m47s from merge
  to post-deploy verification.
- `ready_status_truth`: improved because stale terminal-stage accounting and stage-credit launch evidence are now
  explicit. The runtime surface is not falsely green: it reports the swarm freeze and material-action holds.
- `manual_intervention_count`: zero direct cluster mutations from the local shell.
- `handoff_evidence_quality`: PR progress comments, this rollout doc, the mission ledger, the verify handoff, and NATS
  updates carry the same merge/rollout/runtime blocker evidence.

## Rollback path

- Roll back through GitOps by reverting the relevant feature PR and its promotion PR, not by mutating live workloads
  directly.
- Latest full Jangar image rollback target: revert #6378 or promote the prior known-good `fdc164d7` image from #6365.
- Feature-level rollback options:
  - Revert #6367 if terminal-run freshness accounting regresses swarm status.
  - Revert #6363 if stage-credit launch evidence regresses controller readiness.
  - Revert #6349, #6343, #6339, #6330, or #6324 in reverse order if their status surfaces regress.
- Runtime safety fallback is already conservative: dispatch, paper, and live actions are held or blocked while Torghut
  route/settlement evidence and source-serving receipts are missing or while the swarm is frozen.

## Next action

Smallest blocker preventing full business-metric improvement: stop implement-run evictions by adding an evidence-backed
runner ephemeral-storage request/limit or workspace cleanup path, then re-run the implement stage after the freeze
expires. The next PR blocker is #6372, which needs a conflict resolution in
`docs/torghut/design-system/v6/index.md` before its typed Torghut evidence intake can proceed.
