# Jangar control-plane release verification - 2026-05-08

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane-verify`
Release engineer: Marco Silva

## Owner update message

Jangar rollout is healthy at the latest observed main revision
`94fa92a40a561a7c9d7f39d383ed1bb2b848e3f9`. Argo CD reports `jangar`, `agents`, `symphony-jangar`, and
`agents-ci` synced and healthy; `deployment/jangar` is rolled out on
`registry.ide-newton.ts.net/lab/jangar:03eea88e@sha256:30c7b317810bcbc543757ec08f55f3f6b0abf907bb2fad0e950cde7bac924862`.

#5889 remains a no-go even though its mergeability and CI are clean. It is still a 1,639-line direct-control-plane
diff, and the required Codex review has not posted because the connector is returning code-review usage-limit
responses. Adjacent Torghut/Jangar-continuity PRs #6002 and #6005 also finished green; GitHub cancelled the
superseded #6002 `torghut-ci` run in favor of #6005, and the Torghut apps are synced and healthy.

## PRs touched

- #5995 `fix(jangar): include repo metadata in market context runs`
  - Earlier same-day active Jangar runtime PR.
  - Head: `4fc15a62404fff996a3198a94a84ff73ee49184a`.
  - Squash merge commit: `7a73733686737a2604ecf9280e34f136bdb50eed`.
  - Merged at 2026-05-08T00:57:27Z after all required hosted checks passed or skipped, no review threads were
    returned by GraphQL, and the diff stayed below the large-diff Codex review threshold.
  - Progress comment: https://github.com/proompteng/lab/pull/5995#issuecomment-4402291572.
- #5998 `chore(jangar): promote image 7a737336`
  - Generated image promotion for #5995.
  - Head: `5ee59a99bbc3ba809447ecf7e994b7bcebb9da43`.
  - Squash merge commit: `478bde847f7341c93c21f8fd655282d9eba25a39`.
  - Merged at 2026-05-08T01:13:56Z after hosted PR checks passed and no review threads were returned by GraphQL.
  - Promoted Jangar image tag `7a737336`.
  - Progress comment: https://github.com/proompteng/lab/pull/5998#issuecomment-4402460261.
- #6001 `fix(jangar): allow on-demand market context after hours`
  - Latest selected runtime Jangar fix.
  - Head: `a12c99007fec22ef774aed7af00d2cff9ba95049`.
  - Squash merge commit: `9e7b87d813d9732d44586e213d9f47ec178f705a`.
  - Merged at 2026-05-08T01:34:09Z after hosted checks passed or skipped, including `agents-ci / integration` and
    `jangar-ci / lint-and-typecheck`.
  - Diff stayed below the large-diff Codex review threshold.
  - Progress comment: https://github.com/proompteng/lab/pull/6001#issuecomment-4402528017.
- #6004 `chore(jangar): promote image 9e7b87d8`
  - Generated image promotion for #6001.
  - Head: `8475eb10ea0dde0ed4dcc6956bd66aba0d5f9b7c`.
  - Squash merge commit: `320ed472f4edef4ad86a5cf258b21096f12b3e60`.
  - Merged at 2026-05-08T01:45:04Z after hosted PR checks passed or skipped.
  - Promoted Jangar image tag `9e7b87d8` with digest
    `sha256:758e880b2e9ec439d2dfceb41a170c2352ca63108c90be81be321f8d56cafda4`.
  - Progress comment: https://github.com/proompteng/lab/pull/6004#issuecomment-4402632642.
- #6002 `fix(torghut): gate route packets on jangar continuity`
  - Concurrent Torghut/Jangar-adjacent PR that merged while the Jangar rollout was closing.
  - Head: `e4b20f226ea97f3b8c76042c7bc42d2ed816b024`.
  - Squash merge commit: `7d88cb2a34d47c2d857c8c0824bbaa5d8cdcdcf4`.
  - PR checks were green before merge; its first main `torghut-ci` run was cancelled by GitHub concurrency after #6005
    superseded it.
- #6005 `chore(torghut): promote image 7d88cb2a`
  - Generated Torghut promotion for #6002.
  - Head: `b7ac4744b63c3e3c31b5c0475a0e9f134fe860b2`.
  - Squash merge commit: `227aaa46b75071da8f237f0f3f99ba75e9e27187`.
  - Main `torghut-ci`, `torghut-post-deploy-verify`, `argo-lint`, and `kubeconform` passed after merge.
- #5889 `feat(jangar): add repair warrant exchange`
  - Rechecked as the remaining direct Jangar control-plane implementation PR.
  - Head: `bb5ad076224db16902463bc6f634fa01f785232c`.
  - Hosted checks: pass or skipped only, including `agents-ci / integration`.
  - No merge: the diff is 1,639 changed lines, so the required >1000-line Codex review gate applies.
  - Latest Codex review request: https://github.com/proompteng/lab/pull/5889#issuecomment-4402572839.
  - Latest connector blocker: https://github.com/proompteng/lab/pull/5889#issuecomment-4402573381.
  - Progress comment: https://github.com/proompteng/lab/pull/5889#issuecomment-4398288855.
- #6060 `docs(jangar): refresh control plane release gate`
  - Current audit PR on `codex/swarm-jangar-control-plane-verify`.
  - Rebased onto `origin/main` at `94fa92a40a561a7c9d7f39d383ed1bb2b848e3f9`.
  - Refreshes the durable release record for the completed Jangar rollout and the remaining #5889 blocker.

## Comments and conflicts

- #5995, #5998, #6001, and #6004 had no unresolved review threads at their final gates.
- #5995, #5998, #6001, and #6004 stayed below the mandatory large-diff Codex review threshold.
- #5889 had no active review threads, but it remains held because no Codex review has posted for the large diff.
- #6060 was rebased onto current `origin/main`; no merge conflicts were present.

## Merge outcomes

- Merged Jangar runtime and promotion PRs:
  - #5995 -> `7a73733686737a2604ecf9280e34f136bdb50eed`.
  - #5998 -> `478bde847f7341c93c21f8fd655282d9eba25a39`.
  - #6001 -> `9e7b87d813d9732d44586e213d9f47ec178f705a`.
  - #6004 -> `320ed472f4edef4ad86a5cf258b21096f12b3e60`.
- Observed adjacent main after rollout:
  - #6002 -> `7d88cb2a34d47c2d857c8c0824bbaa5d8cdcdcf4`.
  - #6005 -> `227aaa46b75071da8f237f0f3f99ba75e9e27187`.
- Held:
  - #5889: no-go until Codex review capacity returns and a review posts, or a maintainer records an explicit waiver
    and all checks/review threads remain clean.

## Deployment evidence

- Build and promotion for #6001:
  - Main `agents-ci` run `25531623817`: passed, including integration in 13m52s.
  - `jangar-build-push` run `25531623818`: passed in 9m58s.
  - `jangar-release` run `25531919881`: passed and opened #6004.
- #6004 promotion checks:
  - Hosted PR checks passed or skipped: semantic checks, `argo-lint`, `kubeconform`, and
    `jangar-ci / lint-and-typecheck`.
  - Main promotion push checks passed: `argo-lint` run `25531945115`, `kubeconform` run `25531945125`, and
    `jangar-post-deploy-verify` run `25531945117` in 3m13s.
- Promoted image:
  - `registry.ide-newton.ts.net/lab/jangar:9e7b87d8@sha256:758e880b2e9ec439d2dfceb41a170c2352ca63108c90be81be321f8d56cafda4`.
- GitOps status:
  - `jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `227aaa46b75071da8f237f0f3f99ba75e9e27187`.
  - `agents`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `227aaa46b75071da8f237f0f3f99ba75e9e27187`.
  - `symphony-jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `227aaa46b75071da8f237f0f3f99ba75e9e27187`.
- Workload readiness:
  - `deployment/jangar`: rollout status succeeded.
  - Pod `jangar-95db5f698-625qt`: `Running`; `app` ready, `docker` ready; zero restarts.
  - Active app image:
    `registry.ide-newton.ts.net/lab/jangar:9e7b87d8@sha256:758e880b2e9ec439d2dfceb41a170c2352ca63108c90be81be321f8d56cafda4`.
  - `deployment/agents`: `1/1` ready and available on
    `registry.ide-newton.ts.net/lab/jangar-control-plane:9e7b87d8@sha256:7b6723da7e22d868b33d4b1db9b2b819e94d56c59cb6564e590b4ad2b216b536`.
  - `deployment/agents-controllers`: `2/2` ready and available on
    `registry.ide-newton.ts.net/lab/jangar:9e7b87d8@sha256:758e880b2e9ec439d2dfceb41a170c2352ca63108c90be81be321f8d56cafda4`.
- Events:
  - Recent warning events were transient readiness-probe failures during replacement pod startup.
  - Current Argo health, rollout status, and pod readiness cleared those rollout warnings.
  - Remaining `NoPods` events are for unrelated `elasticsearch-master-pdb`.
- Adjacent rollout health:
  - #6002 `fix(torghut): gate route packets on jangar continuity` merged as
    `7d88cb2a34d47c2d857c8c0824bbaa5d8cdcdcf4`; `torghut-build-push` run `25532045493` passed.
  - #6005 `chore(torghut): promote image 7d88cb2a` merged as
    `227aaa46b75071da8f237f0f3f99ba75e9e27187`.
  - `torghut`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `227aaa46b75071da8f237f0f3f99ba75e9e27187`.
  - `torghut-options`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `227aaa46b75071da8f237f0f3f99ba75e9e27187`.
  - `torghut-release` run `25532123835`, #6005 `torghut-ci` run `25532144730`, `torghut-post-deploy-verify` run
    `25532144727`, `argo-lint` run `25532144724`, and `kubeconform` run `25532144729` passed.

## Risks and rollback path

- Residual risk:
  - #6001 changes on-demand market-context repair preflight behavior. Watch Jangar market-context logs and `agents`
    namespace AgentRuns for unexpected dispatch failures or run volume.
  - #5889 remains open and direct-control-plane relevant, but it is not live.
  - #6002/#6005 are adjacent Torghut rollout activity, not part of the Jangar merge gate. Watch Torghut/Jangar
    continuity route signals alongside the Jangar market-context checks.
- Rollback:
  - First rollback step for the latest Jangar slice is a normal GitOps revert PR for #6004 to restore image
    `7a737336@sha256:c76d5d0ad0c698317e9c5f308129eb3ad01f45b72693144251271255af90e320`.
  - If reverting the image does not clear the issue, revert #6001 through a normal PR and let CI/CD build and promote a
    replacement image.
  - If the earlier #5995/#5998 slice is implicated, revert the #5998 image promotion back to
    `093b1f79@sha256:089d68520cbdab6fc62eb142999d3ab2c367e961907e1e9d2a9e14b9cca5d7f5`, then revert #5995 if
    needed.
  - Do not mutate production workloads directly from a local shell.

## Next action

- Merge #6060 only after its rebased hosted checks are green.
- Keep #5889 held until Codex review quota/access is restored and a review posts, or a maintainer explicitly waives the
  large-diff gate.
- Continue normal post-release watch on market-context AgentRuns, Torghut/Jangar continuity route signals, Jangar logs,
  and readiness signals for the promoted `9e7b87d8` image.

## Later gate refresh - 2026-05-08T05:59Z

Governing runtime requirement: `docs/agents/designs/146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md`
requires observe-mode repair warrants to stay zero-notional, fresh, and non-capital-authorizing until closure evidence is
present. I used that contract to keep #5889 selected as the remaining direct Jangar control-plane PR, but not mergeable
without the large-diff review gate.

- #5889 `feat(jangar): add repair warrant exchange`
  - Head: `306c069941bcbddb6e21b6f42591d14503272e9f`.
  - Mergeability: `CLEAN` / `MERGEABLE`.
  - Diff: 18 files, 1,591 additions, 48 deletions, 1,639 total changed lines.
  - Checks: pass or skipped only, including `agents-ci / integration` in 12m01s,
    `jangar-ci / lint-and-typecheck`, `agents-ci / validate`, semantic title, semantic commits, and changed-file
    checks.
  - Comments: no unresolved review threads returned by GraphQL; no posted Codex review exists.
  - Merge decision: no-go. The PR exceeds the 1,000-line threshold and repeated `@codex review` requests for the
    current and prior heads received the Codex usage-limit response instead of a review.
  - Progress comment refreshed at https://github.com/proompteng/lab/pull/5889#issuecomment-4398288855.
- Current live GitOps health after main advanced to `afda308ea5af1658d173d2b3d2dbd014519be6e5`:
  - `argocd/jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `afda308ea5af1658d173d2b3d2dbd014519be6e5`.
  - `argocd/agents`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `afda308ea5af1658d173d2b3d2dbd014519be6e5`.
  - `argocd/symphony-jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `ce7dd3a8158d1085c74e8d1bf6116e62110a6b50`.
  - `argocd/agents-ci`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `ce7dd3a8158d1085c74e8d1bf6116e62110a6b50`.
  - Rollout status succeeded for `deployment/jangar`, `deployment/agents`, `deployment/agents-controllers`, and
    `deployment/symphony-jangar`.
  - Active images: `deployment/jangar` and `deployment/agents-controllers` are on
    `registry.ide-newton.ts.net/lab/jangar:03eea88e@sha256:30c7b317810bcbc543757ec08f55f3f6b0abf907bb2fad0e950cde7bac924862`;
    `deployment/agents` is on
    `registry.ide-newton.ts.net/lab/jangar-control-plane:03eea88e@sha256:94aaf5282dab1183e176885d345806d855d09e4ad7e9197dc3347864a4dcd64a`.
  - Recent Jangar/Agents warnings were rollout-start readiness and liveness probes that cleared after the new pods
    became ready; recurring `elasticsearch-master-pdb` `NoPods` events are unrelated to the Jangar rollout gate.
- Runtime/business metric evidence:
  - `failed_agentrun_rate`: Jangar control-plane AgentRuns created since 2026-05-08T00:00Z show 20 total, 17
    succeeded, 0 failed, and 3 running at the observation point. Historical Jangar control-plane AgentRuns in the
    namespace show 210 total, 200 succeeded, 7 failed, and 3 running.
  - `ready_status_truth`: Argo, rollout status, pod readiness, and active images agree for the deployed control-plane
    state.
  - `manual_intervention_count`: zero production workload mutations were made from the local shell; validation was
    read-only cluster inspection plus local kubeconfig context setup.
  - `pr_to_rollout_latency`: no new Jangar PR merged in this refresh because #5889 is held by the mandatory review
    gate, so the smallest blocker preventing improvement is Codex review capacity or an explicit maintainer waiver.
  - `handoff_evidence_quality`: PR checks, review blocker, Argo status, rollout status, image digests, events, and
    AgentRun counts are recorded here and in `/workspace/.agentrun/swarm/jangar-control-plane-verify.md`.
- Rollback path:
  - #5889 has no runtime rollback because it was not merged.
  - For the currently deployed Jangar image, use a normal GitOps revert PR for #6045 to restore the previous
    `9b1bc3dc` image, then revert #6043/#6039 if the mission-contract runtime slice is implicated.
  - Do not mutate production workloads directly from a local shell.
- Next action:
  - Keep #5889 held until an actual Codex review posts for `306c069941bcbddb6e21b6f42591d14503272e9f` and all review
    threads are resolved, or a maintainer explicitly waives the large-diff gate.
  - If #5889 is rebased or changed, rerun the smallest relevant local Jangar validation plus hosted PR checks before
    any merge decision.

## Current gate refresh - 2026-05-08T06:57Z

Governing release requirement: verify stages must merge only green PRs and prove Argo sync, workload readiness, and
service health after rollout. I used that gate, plus the same repair-warrant design provenance above, to re-evaluate
the remaining open Jangar control-plane work without changing production.

- PR enumeration:
  - #5889 `feat(jangar): add repair warrant exchange` is the only open direct Jangar control-plane implementation PR.
  - #5412 `feat(torghut): add profit escrow runtime projections` is Torghut-owned and also over the large-diff
    threshold, with Codex review blocked by the same connector usage-limit response.
  - #6058 `ci(torghut): keep release manifest checks complete` is Torghut CI-only, green, and not selected for this
    Jangar release gate.
- #5889 merge gate:
  - Head: `eb42fef4febc720b6fad47188c6c34913da465b8`.
  - Mergeability: GitHub reports `CLEAN` / `MERGEABLE`; REST reports `mergeable_state=clean`.
  - Checks: pass or skipped only, including `CI / check_changed_files`, semantic title and commit checks,
    `agents-ci / validate`, `agents-ci / integration`, and `jangar-ci / lint-and-typecheck / run`.
  - Comments: GraphQL returned no review threads and no posted opinionated reviews.
  - Diff: 18 files, 1,591 additions, 48 deletions, 1,639 total changed lines.
  - Decision: no-go. The PR exceeds the 1,000-line large-diff gate and no Codex review has posted. Repeated
    `@codex review` requests for the current and prior heads received the connector usage-limit response.
  - Progress comment refreshed at https://github.com/proompteng/lab/pull/5889#issuecomment-4398288855.
- Current live rollout health:
  - `argocd/jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `61c0fe2459b3cfc9db45e65518e85ab17d693775`.
  - `argocd/agents`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `61c0fe2459b3cfc9db45e65518e85ab17d693775`.
  - `argocd/symphony-jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `61c0fe2459b3cfc9db45e65518e85ab17d693775`.
  - `deployment/jangar`, `deployment/agents`, `deployment/agents-controllers`, and `deployment/symphony-jangar`
    reported rollout success.
  - Active images: `deployment/jangar` and `deployment/agents-controllers` are on
    `registry.ide-newton.ts.net/lab/jangar:03eea88e@sha256:30c7b317810bcbc543757ec08f55f3f6b0abf907bb2fad0e950cde7bac924862`;
    `deployment/agents` is on
    `registry.ide-newton.ts.net/lab/jangar-control-plane:03eea88e@sha256:94aaf5282dab1183e176885d345806d855d09e4ad7e9197dc3347864a4dcd64a`.
  - Service health: Jangar service proxy `/health` returned `status=ok`; Symphony `/readyz` returned `ok=true`.
    Agents service proxy and pod exec were blocked by RBAC, but `deployment/agents` was `1/1` ready and its service had
    a ready endpoint on port 8080.
  - Event scan: recent Jangar/Agents warnings were readiness-probe timeouts during pod replacement and are cleared by
    current rollout readiness. Current non-Jangar warnings include Torghut rollout-start probes, Keycloak restart,
    Rook/Ceph, and persistent-volume cleanup issues; none blocks the Jangar rollout gate.
- Runtime and business metric evidence:
  - `failed_agentrun_rate`: Jangar control-plane AgentRuns since 2026-05-08T00:00Z show 23 total, 22 succeeded, 1
    running, and 0 failed. Historical non-template Jangar control-plane AgentRuns show 213 total, 205 succeeded, 7
    failed, and 1 running.
  - `ready_status_truth`: Argo sync, rollout status, pod readiness, service proxy health where permitted, endpoints,
    and image digests agree for the deployed Jangar control-plane state.
  - `manual_intervention_count`: zero production workload mutations were made from the local shell; cluster work was
    read-only inspection plus local kubeconfig bootstrap using the in-cluster service account.
  - `pr_to_rollout_latency`: no new Jangar PR merged in this refresh because #5889 is held by the mandatory
    large-diff review gate.
  - `handoff_evidence_quality`: the PR check state, review blocker, progress comment, Argo status, rollout status,
    service health signals, event scan, and AgentRun counts are recorded here and in
    `/workspace/.agentrun/swarm/jangar-control-plane-verify.md`.
- Rollback path:
  - #5889 has no runtime rollback because it was not merged.
  - For the currently deployed Jangar image, use a normal GitOps revert PR for the `03eea88e` promotion to restore the
    previous promoted image, then revert the underlying runtime PR if the image rollback does not clear the issue.
  - Do not mutate production workloads directly from a local shell.
- Next action:
  - Keep #5889 held until an actual Codex review posts for
    `eb42fef4febc720b6fad47188c6c34913da465b8` and all review threads are resolved, or a maintainer explicitly waives
    the large-diff gate.
  - After review capacity or waiver is available, recheck mergeability, hosted checks, review threads, and live rollout
    health before any squash merge.

## Current gate refresh - 2026-05-08T07:55Z

Governing release requirement: verify stages must merge only green PRs and prove Argo sync, workload readiness, and
service health after rollout. The active runtime contract for the selected implementation PR remains
`docs/agents/designs/146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md`, which keeps repair
warrants zero-notional and non-capital-authorizing until closure evidence is present.

- PR enumeration:
  - #5889 `feat(jangar): add repair warrant exchange` is the only open direct Jangar control-plane implementation PR.
  - #6060 `docs(jangar): refresh control plane release gate` is the current audit PR on
    `codex/swarm-jangar-control-plane-verify`.
  - #5412 is Torghut-owned and #5767/#5316 are automated release PRs, so they are not selected for the Jangar
    control-plane runtime gate.
- #5889 merge gate:
  - Head: `eb42fef4febc720b6fad47188c6c34913da465b8`.
  - Mergeability: GitHub reports `CLEAN` / `MERGEABLE`.
  - Checks: pass or skipped only, including `CI / check_changed_files`, semantic title and commit checks,
    `agents-ci / validate`, `agents-ci / integration`, and `jangar-ci / lint-and-typecheck / run`.
  - Comments: GraphQL returned zero review threads and zero posted reviews.
  - Diff: 18 files, 1,591 additions, 48 deletions, 1,639 total changed lines.
  - Decision: no-go. The PR exceeds the 1,000-line large-diff gate and no Codex review has posted. Repeated
    `@codex review` requests for the current and prior heads received the connector usage-limit response.
- Current live rollout health:
  - `argocd/jangar`, `argocd/agents`, `argocd/symphony-jangar`, and `argocd/agents-ci`: `Synced`, `Healthy`,
    operation `Succeeded`, revision `94fa92a40a561a7c9d7f39d383ed1bb2b848e3f9`.
  - Rollout status succeeded for `deployment/jangar`, `deployment/agents`, `deployment/agents-controllers`, and
    `deployment/symphony-jangar`.
  - Active images: `deployment/jangar` and `deployment/agents-controllers` are on
    `registry.ide-newton.ts.net/lab/jangar:03eea88e@sha256:30c7b317810bcbc543757ec08f55f3f6b0abf907bb2fad0e950cde7bac924862`;
    `deployment/agents` is on
    `registry.ide-newton.ts.net/lab/jangar-control-plane:03eea88e@sha256:94aaf5282dab1183e176885d345806d855d09e4ad7e9197dc3347864a4dcd64a`;
    `deployment/symphony-jangar` is on
    `registry.ide-newton.ts.net/lab/symphony:2ea968af@sha256:dcd024f0abcb0615f698211df530056b196f0e050cedd19c118ac566eb415243`.
  - Service health: Jangar service proxy `/health` returned `status=ok`; Symphony `/readyz` returned `ok=true`.
    Agents service proxy remained blocked by RBAC, but `deployment/agents` was `1/1` ready and had a ready endpoint on
    port 8080.
  - Control-plane service health: `/api/agents/control-plane/status?namespace=agents` reported leader election active,
    controllers healthy, heartbeat authority fresh, database connected, and migrations consistent.
  - Event scan: recent warnings in the Jangar/Agents surface were transient readiness probe timeouts on
    `agents-controllers` pods that are now ready; Jangar namespace events were normal at the observation point.
- Runtime and business metric evidence:
  - `failed_agentrun_rate`: Jangar control-plane AgentRuns since 2026-05-08T00:00Z show 26 total, 25 succeeded, 1
    running, and 0 failed. Historical Jangar control-plane AgentRuns show 216 total, 208 succeeded, 7 failed, and 1
    running.
  - `ready_status_truth`: Argo sync, rollout status, pod readiness, endpoints, service health where RBAC permits,
    controller heartbeats, database health, and image digests agree for the deployed Jangar control-plane state.
  - `manual_intervention_count`: zero production workload mutations were made from the local shell; cluster work was
    read-only inspection plus local kubeconfig bootstrap using the in-cluster service account.
  - `pr_to_rollout_latency`: no new Jangar runtime PR merged in this refresh because #5889 is held by the mandatory
    large-diff review gate.
  - `handoff_evidence_quality`: PR checks, review blocker, progress comment, Argo status, rollout status, service
    health, event scan, and AgentRun counts are recorded here and in
    `/workspace/.agentrun/swarm/jangar-control-plane-verify.md`.
- Rollback path:
  - #5889 has no runtime rollback because it was not merged.
  - For the currently deployed Jangar image, use a normal GitOps revert PR for the `03eea88e` promotion to restore the
    previous promoted image, then revert the underlying runtime PR if the image rollback does not clear the issue.
  - Do not mutate production workloads directly from a local shell.
- Next action:
  - Keep #5889 held until an actual Codex review posts for
    `eb42fef4febc720b6fad47188c6c34913da465b8` and all review threads are resolved, or a maintainer explicitly waives
    the large-diff gate.
  - After review capacity or waiver is available, recheck mergeability, hosted checks, review threads, and live rollout
    health before any squash merge.

## Current gate refresh - 2026-05-08T08:56Z

Governing release requirement: verify stages must merge only green PRs and prove Argo sync, workload readiness, and
service health after rollout. The direct implementation contract is still
`docs/agents/designs/146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md`, which keeps repair
warrants observe-mode, zero-notional, and non-capital-authorizing until closure evidence exists.

- PR enumeration:
  - #5889 `feat(jangar): add repair warrant exchange` is the only open direct Jangar control-plane implementation PR.
  - #5412 `feat(torghut): add profit escrow runtime projections` is Torghut-owned but Jangar-impacting through the
    control-plane Torghut consumer-evidence integration and related tests.
  - #5767 and #5316 are automated release PRs and were not selected for this Jangar control-plane runtime gate.
- #5889 merge gate:
  - Head: `50bdd4b1aa7ec7bf849a06d34a9f146b2a21ebf3`.
  - Mergeability: GitHub reports `MERGEABLE`.
  - Checks: pass or skipped only, including `CI / check_changed_files`, semantic title and commit checks,
    `agents-ci / validate`, `agents-ci / integration`, and `jangar-ci / lint-and-typecheck / run`.
  - Comments: GraphQL returned zero review threads and zero posted reviews.
  - Diff: 18 files, 1,591 additions, 48 deletions, 1,639 total changed lines.
  - Progress comment refreshed at https://github.com/proompteng/lab/pull/5889#issuecomment-4398288855.
  - Decision: no-go. The PR exceeds the 1,000-line large-diff review gate, and the latest current-head Codex review
    request at https://github.com/proompteng/lab/pull/5889#issuecomment-4404810354 received the connector usage-limit
    response at https://github.com/proompteng/lab/pull/5889#issuecomment-4404811591.
- #5412 adjacent gate:
  - Head: `16c783467af02fecfb9f2434ae17167ff43da217`.
  - Mergeability: GitHub reports `MERGEABLE`.
  - Checks: not terminal green because `agents-ci / integration` is still pending. Passing checks include semantic
    title and commit checks, changed-file checks, `agents-ci / validate`, `jangar-ci / lint-and-typecheck / run`,
    `torghut-ci / Pyright`, `torghut-ci / Bytecode + pytest + coverage`, and
    `torghut-ci / Quality signals (complexity + security)`.
  - Comments: GraphQL returned zero review threads and zero current posted reviews.
  - Diff: 33 files, 8,074 additions, 617 deletions, 8,691 total changed lines.
  - Progress comment refreshed at https://github.com/proompteng/lab/pull/5412#issuecomment-4404049669.
  - Decision: no-go. It is pending integration and the latest current-head Codex review request at
    https://github.com/proompteng/lab/pull/5412#issuecomment-4405081805 received the connector usage-limit response at
    https://github.com/proompteng/lab/pull/5412#issuecomment-4405083087.
- Current live rollout health:
  - `argocd/jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `61f2e2e4a6b68787b7fcd1fcbb7a75094cc4cace`.
  - `argocd/agents`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `f4726013a1466e67a919482f5bb5e4fb3bc0c4b7`.
  - `argocd/symphony-jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `61f2e2e4a6b68787b7fcd1fcbb7a75094cc4cace`.
  - `argocd/agents-ci`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `61f2e2e4a6b68787b7fcd1fcbb7a75094cc4cace`.
  - Rollout status succeeded for `deployment/jangar`, `deployment/agents`, `deployment/agents-controllers`, and
    `deployment/symphony-jangar`.
  - Active images: `deployment/jangar` and `deployment/agents-controllers` are on
    `registry.ide-newton.ts.net/lab/jangar:03eea88e@sha256:30c7b317810bcbc543757ec08f55f3f6b0abf907bb2fad0e950cde7bac924862`;
    `deployment/agents` is on
    `registry.ide-newton.ts.net/lab/jangar-control-plane:03eea88e@sha256:94aaf5282dab1183e176885d345806d855d09e4ad7e9197dc3347864a4dcd64a`;
    `deployment/symphony-jangar` is on
    `registry.ide-newton.ts.net/lab/symphony:2ea968af@sha256:dcd024f0abcb0615f698211df530056b196f0e050cedd19c118ac566eb415243`.
  - Pod readiness: `jangar-768f6ccddb-65vsb` is Running with `app` and `docker` ready and zero restarts;
    `agents-5cd5c88b59-dq9c5` is Running and ready with one historical restart; both `agents-controllers` pods are
    Running and ready, with restart counts 2 and 0.
  - Endpoints: `jangar` -> `10.244.5.5:8080`, `symphony-jangar` -> `10.244.5.30:8080`, and `agents` ->
    `10.244.5.135:8080`.
  - Service health: Jangar `/health` returned `status=ok`, and Symphony `/readyz` returned `ok=true`.
  - Control-plane status: leader election is active, `agents-controller`, `supporting-controller`, and
    `orchestration-controller` are healthy, database and migration consistency are healthy, watch reliability and
    execution trust are healthy, Torghut consumer evidence is current, and empirical jobs are healthy.
  - Material-action truth: `serve_readonly` and `torghut_observe` are allowed; `dispatch_repair`, `dispatch_normal`,
    `deploy_widen`, `merge_ready`, and `paper_canary` are held; `live_micro_canary` and `live_scale` are blocked.
    That is conservative and supports the no-go merge decision rather than promotion.
  - Event scan: Jangar namespace has no warning events at the observation point. Agents namespace has recent
    Torghut market-context scheduling warnings and transient readiness-probe warnings for ready agents pods; current
    rollout and pod readiness have cleared the readiness warnings for the Jangar control-plane gate.
- Runtime and business metric evidence:
  - `failed_agentrun_rate`: Jangar control-plane AgentRuns since 2026-05-08T00:00Z show 62 total, 58 succeeded, 0
    failed, and 4 running. Historical matching runs show 449 total, 422 succeeded, 19 failed, and 4 running.
  - `ready_status_truth`: Argo sync, rollout status, pod readiness, endpoints, service health, controller heartbeats,
    database health, watch reliability, material-action decisions, and image digests agree for the deployed baseline.
  - `manual_intervention_count`: zero production workload mutations were made from the local shell; cluster work was
    read-only inspection plus local kubeconfig bootstrap using the in-cluster service account.
  - `pr_to_rollout_latency`: no new Jangar runtime PR merged in this refresh because #5889 is held by the mandatory
    large-diff review gate and #5412 is both pending integration and review-gated.
  - `handoff_evidence_quality`: PR checks, progress comments, review blocker links, Argo status, rollout status,
    service health, material-action truth, event scan, and AgentRun counts are recorded here and in
    `/workspace/.agentrun/swarm/jangar-control-plane-verify.md`.
- Rollback path:
  - #5889 and #5412 have no runtime rollback from this gate because neither was merged.
  - For the currently deployed Jangar image, use a normal GitOps revert PR for the `03eea88e` promotion to restore the
    previous promoted image, then revert the underlying runtime PR if image rollback does not clear the issue.
  - Do not mutate production workloads directly from a local shell.
- Next action:
  - Keep #5889 held until an actual Codex review posts for
    `50bdd4b1aa7ec7bf849a06d34a9f146b2a21ebf3` and all review threads are resolved, or a maintainer explicitly waives
    the large-diff gate.
  - Keep #5412 held until `agents-ci / integration` is terminal green and a current-head Codex review posts with all
    review threads resolved, or a maintainer explicitly waives the large-diff gate after checks are green.
  - Recheck mergeability, hosted checks, review threads, and live rollout health before any squash merge.

## Current gate refresh - 2026-05-08T09:56Z

Governing release requirement: verify stages must merge only green PRs and prove Argo sync, workload readiness, and
service health after rollout. The selected direct implementation still maps to
`docs/agents/designs/146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md`, which keeps repair
warrants observe-mode, zero-notional, and non-capital-authorizing until closure evidence exists.

- PR enumeration:
  - #5889 `feat(jangar): add repair warrant exchange` is the only open direct Jangar control-plane implementation PR.
  - #5412 `feat(torghut): add profit escrow runtime projections` remains Jangar-impacting through the control-plane
    Torghut consumer-evidence path, but it is Torghut-owned and governed by the Torghut profit-proof contracts.
- #5889 merge gate:
  - Head: `84f88bb2cd9b00f50c14a75a56faba4ed32310e4`.
  - Mergeability: GitHub reports `MERGEABLE` and `CLEAN`.
  - Checks: pass or skipped only, including `CI / check_changed_files`, semantic title and commit checks,
    `agents-ci / validate`, `agents-ci / integration`, and `jangar-ci / lint-and-typecheck / run`.
  - Comments/reviews: GraphQL reports zero review threads and zero posted reviews.
  - Diff: 18 files, 1,591 additions, 48 deletions, 1,639 total changed lines.
  - Progress comment refreshed at https://github.com/proompteng/lab/pull/5889#issuecomment-4398288855.
  - Decision: no-go. The PR exceeds the mandatory 1,000-line Codex-review gate, and the current-head review request
    at https://github.com/proompteng/lab/pull/5889#issuecomment-4405384955 received the connector usage-limit response
    at https://github.com/proompteng/lab/pull/5889#issuecomment-4405385768. The maintainer `merge it` comment does not
    supply the missing Codex review under the active run requirements.
- #5412 adjacent gate:
  - Head: `33c711fe3ed5ceb868d44bc516b893948c41b37a`.
  - Mergeability: GitHub reports `MERGEABLE` and `CLEAN`.
  - Checks: pass or skipped only, including `CI / check_changed_files`, semantic title and commit checks,
    `agents-ci / validate`, `agents-ci / integration`, `jangar-ci / lint-and-typecheck / run`, and the observed
    `torghut-ci` pyright, pytest, coverage, migration guard, and quality-signal jobs.
  - Comments/reviews: GraphQL reports zero review threads and zero posted reviews.
  - Diff: 33 files, 8,203 additions, 737 deletions, 8,940 total changed lines.
  - Progress comment refreshed at https://github.com/proompteng/lab/pull/5412#issuecomment-4404049669.
  - Decision: no-go. It is clean and green now, but it remains far above the large-diff Codex-review threshold and the
    latest connector response at https://github.com/proompteng/lab/pull/5412#issuecomment-4405416327 is still the
    account usage-limit blocker.
- Current live rollout health:
  - `argocd/jangar`, `argocd/agents`, `argocd/symphony-jangar`, and `argocd/agents-ci` are `Synced`, `Healthy`,
    operation `Succeeded`, revision `a1fcc37625ee1a7104071c9dbcb0a386bb7868b2`.
  - Rollout status succeeded for `deployment/jangar`, `deployment/agents`, `deployment/agents-controllers`, and
    `deployment/symphony-jangar`.
  - Active images: `deployment/jangar` and `deployment/agents-controllers` are on
    `registry.ide-newton.ts.net/lab/jangar:03eea88e@sha256:30c7b317810bcbc543757ec08f55f3f6b0abf907bb2fad0e950cde7bac924862`;
    `deployment/agents` is on
    `registry.ide-newton.ts.net/lab/jangar-control-plane:03eea88e@sha256:94aaf5282dab1183e176885d345806d855d09e4ad7e9197dc3347864a4dcd64a`;
    `deployment/symphony-jangar` is on
    `registry.ide-newton.ts.net/lab/symphony:2ea968af@sha256:dcd024f0abcb0615f698211df530056b196f0e050cedd19c118ac566eb415243`.
  - Pods and endpoints: `jangar` is `2/2` ready, `agents` is `1/1` ready, `agents-controllers` is `2/2` ready,
    `symphony-jangar` is `1/1` ready, and endpoints exist for `jangar`, `agents`, and `symphony-jangar` on port 8080.
  - Service health: Jangar `/health` returned `status=ok`; Symphony `/readyz` returned `ok=true`.
  - Control-plane status: controller authority is healthy for `agents-controller`, `supporting-controller`, and
    `orchestration-controller`; the database is connected; migration consistency is healthy with 28 registered and 28
    applied migrations.
  - Event scan: recent warnings on the Jangar/Agents surface are transient `agents-controllers` readiness-probe
    timeouts and historical AgentRun job errors; current deployments and endpoints are ready.
- Runtime and business metric evidence:
  - `failed_agentrun_rate`: Jangar control-plane AgentRuns created since 2026-05-08T00:00Z show 34 total, 33
    succeeded, 1 running, and 0 failed. Historical matching AgentRuns show 224 total, 216 succeeded, 1 running, and 7
    failed.
  - `ready_status_truth`: Argo sync, rollout status, pod readiness, endpoints, service health, controller authority,
    database/migration health, and image digests agree for the deployed baseline.
  - `manual_intervention_count`: zero production workload mutations were made from the local shell; cluster checks were
    read-only.
  - `pr_to_rollout_latency`: not improved in this pass because no runtime PR merged.
  - `handoff_evidence_quality`: PR checks, review blockers, progress comments, GitOps health, rollout status, service
    health, events, AgentRun counts, risk, and rollback path are recorded here and in the swarm handoff files.
- Rollback path:
  - #5889 and #5412 have no runtime rollback from this pass because neither PR merged.
  - For the currently deployed Jangar image, use a normal GitOps revert PR for the `03eea88e` promotion to restore the
    previous promoted image, then revert the underlying runtime PR if image rollback does not clear the issue.
  - Do not mutate production workloads directly from a local shell.
- Next action:
  - Keep #5889 held until an actual Codex review posts for
    `84f88bb2cd9b00f50c14a75a56faba4ed32310e4` and all review threads are resolved.
  - Keep #5412 held until an actual Codex review posts for
    `33c711fe3ed5ceb868d44bc516b893948c41b37a` and all review threads are resolved.
  - After review capacity returns, recheck mergeability, hosted checks, review threads, and live rollout health before
    any squash merge.
