# Jangar control-plane release verification - 2026-05-08

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane-verify`
Release engineer: Marco Silva

## Owner update message

Jangar rollout is healthy after the #5995 market-context repository metadata release and the generated #5998 image
promotion. The runtime gate is green at latest observed main revision
`5fa0f9b8f97423fa93bd0066a85434c16abdb992`, with Argo CD `jangar`, `agents`, and `symphony-jangar` synced and
healthy. `deployment/jangar` is rolled out on
`registry.ide-newton.ts.net/lab/jangar:7a737336@sha256:c76d5d0ad0c698317e9c5f308129eb3ad01f45b72693144251271255af90e320`.

#5889 remains a no-go even though its mergeability and CI are clean. It is still a 1,639-line direct-control-plane
diff, and the required Codex review has not posted because the connector is returning code-review usage-limit
responses.

## PRs touched

- #5995 `fix(jangar): include repo metadata in market context runs`
  - Selected as the active unblock-first Jangar runtime PR.
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
- #5889 `feat(jangar): add repair warrant exchange`
  - Rechecked as the remaining direct Jangar control-plane implementation PR.
  - Head: `bb5ad076224db16902463bc6f634fa01f785232c`.
  - Hosted checks: pass or skipped only, including `agents-ci / integration`.
  - No merge: the diff is 1,639 changed lines, so the required >1000-line Codex review gate applies.
  - Latest Codex review request: https://github.com/proompteng/lab/pull/5889#issuecomment-4402264356.
  - Latest connector blocker: https://github.com/proompteng/lab/pull/5889#issuecomment-4402264935.
  - Progress comment: https://github.com/proompteng/lab/pull/5889#issuecomment-4398288855.
- #5999 `docs(jangar): define revision carry action bonds`
  - Concurrent docs-only Jangar/Torghut design PR that merged during rollout closeout.
  - Squash merge commit: `5fa0f9b8f97423fa93bd0066a85434c16abdb992`.
  - Not selected as a runtime release gate, but it is the latest main revision observed by Argo CD during final health
    verification.

## Comments and conflicts

- #5995 and #5998 had no unresolved review threads at their final gates.
- #5995 was 97 changed lines and #5998 was 20 changed lines, so neither triggered the large-diff Codex review gate.
- #5889 had no active review threads, but it remains held because no Codex review has posted for the large diff.
- No merge conflicts were present on the selected runtime PR or promotion PR at their final gates.

## Merge outcomes

- Merged:
  - #5995 -> `7a73733686737a2604ecf9280e34f136bdb50eed`.
  - #5998 -> `478bde847f7341c93c21f8fd655282d9eba25a39`.
- Observed latest main after rollout:
  - #5999 -> `5fa0f9b8f97423fa93bd0066a85434c16abdb992` (docs-only).
- Held:
  - #5889: no-go until Codex review capacity returns and a review posts, or a maintainer records an explicit waiver
    and all checks/review threads remain clean.

## Deployment evidence

- Build and promotion:
  - `jangar-build-push` run `25530503590`: passed in 9m07s.
  - Built image:
    `registry.ide-newton.ts.net/lab/jangar:7a737336@sha256:c76d5d0ad0c698317e9c5f308129eb3ad01f45b72693144251271255af90e320`.
  - Built control-plane image:
    `registry.ide-newton.ts.net/lab/jangar-control-plane:7a737336@sha256:75ef8023a1182b1dba92c993fd64cf32452f09a0cd6996647c49cf22c080c49a`.
  - `jangar-release` run `25530969733`: passed and opened #5998.
- Main and PR checks:
  - #5995 hosted checks passed or skipped; main `agents-ci` run `25530503587` passed, including integration in 12m48s.
  - #5998 hosted checks passed or skipped: semantic checks, `argo-lint`, `kubeconform`, and `jangar-ci / lint-and-typecheck`.
  - #5998 promotion push checks passed: `argo-lint` run `25531010956`, `kubeconform` run `25531010926`, and
    `jangar-post-deploy-verify` run `25531010920`.
- Post-deploy verification:
  - #5995 config rollout verifier `25530503576`: passed for revision `7a73733686737a2604ecf9280e34f136bdb50eed`.
  - #5998 promoted-image verifier `25531010920`: passed in 4m10s.
- GitOps status:
  - `jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `5fa0f9b8f97423fa93bd0066a85434c16abdb992`.
  - `agents`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `5fa0f9b8f97423fa93bd0066a85434c16abdb992`.
  - `symphony-jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `5fa0f9b8f97423fa93bd0066a85434c16abdb992`.
- Workload readiness:
  - `deployment/jangar`: rollout status succeeded.
  - Pod `jangar-64649fbfdc-v2kmh`: `Running`; `app` ready, `docker` ready; zero restarts.
  - Active app image:
    `registry.ide-newton.ts.net/lab/jangar:7a737336@sha256:c76d5d0ad0c698317e9c5f308129eb3ad01f45b72693144251271255af90e320`.
- Events:
  - Recent warning events were transient `FailedScheduling` and readiness-probe failures during replacement pod
    startup.
  - Current Argo health, rollout status, and pod readiness cleared those rollout warnings.
  - Remaining `NoPods` events are for unrelated `elasticsearch-master-pdb`.

## Risks and rollback path

- Residual risk:
  - #5995 changes market-context AgentRun payloads to include repository metadata. Watch Jangar market-context logs and
    `agents` namespace AgentRuns for dispatch failures or unexpected run volume.
  - #5889 remains open and direct-control-plane relevant, but it is not live.
- Rollback:
  - First rollback step is a normal GitOps revert PR for #5998 to restore the previous Jangar image
    `093b1f79@sha256:089d68520cbdab6fc62eb142999d3ab2c367e961907e1e9d2a9e14b9cca5d7f5`.
  - If reverting the image does not clear the issue, revert #5995 through a normal PR and let CI/CD build and promote a
    replacement image.
  - Do not mutate production workloads directly from a local shell.
  - #5999 is docs-only; rollback is a documentation revert if needed.

## Next action

- Keep #5889 held until Codex review quota/access is restored and a review posts, or a maintainer explicitly waives the
  large-diff gate.
- Continue normal post-release watch on market-context AgentRuns, Jangar logs, and readiness signals for the promoted
  `7a737336` image.
