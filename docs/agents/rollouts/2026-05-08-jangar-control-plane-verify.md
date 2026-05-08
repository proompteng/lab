# Jangar control-plane release verification - 2026-05-08

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane-verify`
Release engineer: Marco Silva

## Owner update message

Jangar rollout is healthy after the #5987 market-context dispatch release and the generated #5990 image promotion.
The runtime gate is green at promotion commit `4b85251fff11f65f9ee72d7361308325e145db70`, with Argo CD `jangar`,
`agents`, and `symphony-jangar` synced and healthy and `deployment/jangar` rolled out on image
`registry.ide-newton.ts.net/lab/jangar:ef2bba88@sha256:d8e2313b88b899f27009bdc8637d5bec066e52b1c87abbdb20fc66fc133861aa`.

#5889 remains a no-go despite clean mergeability and green CI because it is a 1,635-line diff and the required Codex
review has not posted. The current blocker is still Codex review quota/access: the latest connector response says
code-review usage limits are exhausted.

The inherited May 5 NATS items #5387, #5364, and #5376 were already merged before this pass, so they were not active
release candidates.

Final live-state refresh: after this release slice, docs-only Torghut PR #5992 merged as
`68fa0ec61d5620834dca282748c5bb7795d20ef9`. Argo CD `jangar` later reported that latest main revision while keeping
the promoted `ef2bba88` Jangar image healthy. The runtime promotion gate remains #5990.

## PRs touched

- #5987 `fix(jangar): dispatch stale market-context repairs`
  - Selected as the current unblock-first direct Jangar runtime PR.
  - Head: `95704bf9a837b90c59ba76ab41b4f427811a8f5e`.
  - Squash merge commit: `ef2bba887ee5c9c8b2397f1670a8046c8bea70fd`.
  - Merged at 2026-05-08T00:01:02Z after terminal pass/skip checks, no unresolved review threads, and a sub-1000-line
    diff.
  - Progress comment: https://github.com/proompteng/lab/pull/5987#issuecomment-4401998795.
- #5990 `chore(jangar): promote image ef2bba88`
  - Generated promotion for #5987.
  - Head: `c070eb462cae3b811dd65a005d3814bdc9fb7062`.
  - Squash merge commit: `4b85251fff11f65f9ee72d7361308325e145db70`.
  - Merged at 2026-05-08T00:12:36Z, promoting Jangar image tag `ef2bba88`.
  - Progress comment: https://github.com/proompteng/lab/pull/5990#issuecomment-4402109216.
- #5991 `docs(jangar): define continuity witness ledger`
  - Docs-only Jangar/Torghut architecture handoff that opened during rollout closeout.
  - Head: `4f9b3fefddf60133034836493382e7443b152220`.
  - Squash merge commit: `5753f9716a632ec602ee580e24ce221d1915f6e6`.
  - Merged at 2026-05-08T00:18:23Z after semantic checks passed; no runtime rollout was required.
  - Progress comment: https://github.com/proompteng/lab/pull/5991#issuecomment-4402111690.
- #5889 `feat(jangar): add repair warrant exchange`
  - Rechecked as the remaining direct Jangar control-plane implementation PR.
  - Head: `c751930241655a439998dc1df2cb5e78ee35bceb`.
  - GitHub state: `CLEAN`/`MERGEABLE`.
  - Hosted checks: pass or skipped only, including `agents-ci / integration`.
  - No merge: diff is 1,635 changed lines (+1589/-46), so the required >1000-line Codex review gate applies.
  - Latest Codex review request: https://github.com/proompteng/lab/pull/5889#issuecomment-4401957825.
  - Latest connector blocker: https://github.com/proompteng/lab/pull/5889#issuecomment-4401958369.
  - Progress comment: https://github.com/proompteng/lab/pull/5889#issuecomment-4398288855.
- #5387 `fix(torghut): restore rollout readiness`
  - Named in inherited NATS context; already merged on 2026-05-05T10:17:03Z as
    `65e4d54152313a6eddef8ca6ce4f6ca193e23af5`.
- #5364 `ci: stabilize agents and jangar checks`
  - Named in inherited NATS context; already merged on 2026-05-05T09:21:18Z as
    `3726ade1c5c11fd33ecd7a6d273d84128979653d`.
- #5376 `fix(torghut): restore live jangar dependency quorum`
  - Named in inherited NATS context; already merged on 2026-05-05T09:16:09Z as
    `3f443891f7f9a4e2058c630e027b69626714cbf6`.
- #5992 `docs(torghut): define route-local profit frontier`
  - Merged during final audit PR closeout as `68fa0ec61d5620834dca282748c5bb7795d20ef9`.
  - Docs-only Torghut PR; not selected as a Jangar runtime release gate.

## Comments and conflicts

- #5987, #5990, and #5991 had no unresolved active review threads at their gates.
- #5987 and #5991 were below the large-diff Codex review threshold.
- #5990 was a generated promotion diff of 20 changed lines (+10/-10), below the large-diff threshold.
- #5889 has zero active review threads, but no posted Codex review. The connector reported code-review usage limits
  exhausted, so the merge gate remains closed.
- No merge conflicts were present on the selected PRs at their final gates.

## Merge outcomes

- Merged:
  - #5987 -> `ef2bba887ee5c9c8b2397f1670a8046c8bea70fd`.
  - #5990 -> `4b85251fff11f65f9ee72d7361308325e145db70`.
  - #5991 -> `5753f9716a632ec602ee580e24ce221d1915f6e6`.
- Held:
  - #5889: no-go until Codex review capacity returns and a review posts, or a maintainer records an explicit waiver
    and all checks/review threads remain clean.

## Deployment evidence

- Build and promotion:
  - `jangar-build-push` run `25528768744`: passed, pushed
    `registry.ide-newton.ts.net/lab/jangar:ef2bba88@sha256:d8e2313b88b899f27009bdc8637d5bec066e52b1c87abbdb20fc66fc133861aa`.
  - Control-plane image pushed:
    `registry.ide-newton.ts.net/lab/jangar-control-plane:ef2bba88@sha256:07dd040c223f05e21803c4d90e9df13ef8ca5bc5bb31c88e98cfb3ea5d80a59e`.
  - `jangar-release` run `25529114116`: passed and opened #5990.
- Post-deploy verification:
  - `jangar-post-deploy-verify` run `25529140218`: passed for promotion commit
    `4b85251fff11f65f9ee72d7361308325e145db70`.
  - Main `agents-ci` run `25528768725`: `validate` and `integration` passed.
- GitOps status:
  - `jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `4b85251fff11f65f9ee72d7361308325e145db70`.
  - `agents`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `4b85251fff11f65f9ee72d7361308325e145db70`.
  - `symphony-jangar`: `Synced`, `Healthy`, operation `Succeeded`, revision
    `4b85251fff11f65f9ee72d7361308325e145db70`.
  - Final refresh: `jangar` later reported `Synced`/`Healthy` at docs-only main revision
    `68fa0ec61d5620834dca282748c5bb7795d20ef9`, with the same promoted `ef2bba88` image in the app summary.
- Workload readiness:
  - `deployment/jangar`: rollout status succeeded.
  - Pod `jangar-57fd7b7c84-t97l8`: `Running`; `app` ready, `docker` ready; zero restarts.
  - Active app image: `sha256:ff7024144a4f21493f9370a9ddb5dcd95056a3093f297110cd904659e7e1331c`
    from promoted index
    `registry.ide-newton.ts.net/lab/jangar:ef2bba88@sha256:d8e2313b88b899f27009bdc8637d5bec066e52b1c87abbdb20fc66fc133861aa`.
- Events:
  - Recent Jangar warning events were readiness probe failures during replacement pod startup for both the config-only
    and promoted-image rollouts.
  - Current Argo health, rollout status, and pod readiness cleared those transient startup warnings.
  - Remaining `NoPods` events are for the unrelated `elasticsearch-master-pdb`.

## Risks and rollback path

- Residual risk:
  - #5889 remains open and direct-control-plane relevant. It is code/CI-clean but blocked by the mandatory Codex review
    gate for large diffs.
  - #5987 introduced on-demand market-context dispatch. The rollout is healthy, but the feature can create AgentRuns
    when stale or missing provider snapshots are observed, so watch `agents` namespace AgentRuns and Jangar logs for
    dispatch failures or unexpected volume.
- Rollback:
  - First rollback step is a normal GitOps revert PR for #5990 to restore the previous Jangar image digest.
  - If reverting the image does not clear the issue, revert #5987 through a normal PR and let the release workflow
    build and promote a replacement image.
  - Do not mutate production workloads directly from a local shell.
  - #5991 is docs-only; rollback is a documentation revert if needed.

## Next action

- Keep #5889 held until Codex review quota/access is restored and a review posts, or a maintainer explicitly waives the
  large-diff gate.
- Continue normal post-release watch on Jangar dispatch AgentRuns and readiness signals for the promoted `ef2bba88`
  image.
