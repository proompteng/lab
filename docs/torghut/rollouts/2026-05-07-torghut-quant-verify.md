# Torghut quant verifier release gate - 2026-05-07

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-07T14:30:00Z

## Owner update message

Torghut production rollout is go for the current merged promotion #5880. The core `torghut`,
`torghut-options`, and `symphony-torghut` Argo CD applications are Synced and Healthy at main
revision `a291127d4ea604e2503a0ff6f94395c2cb549daf`, and the live/sim/options workloads are ready
on image digest `sha256:8db8a40ee7f76c08aaa0689b55e145dfaf872248707a20fb38c005e0eabb42ab`.

The remaining open Torghut quant runtime PR #5412 is no-go for merge. It is conflict-free, has no
unresolved review threads, and all visible checks are green or skipped, but it is a 6,368-line diff
and therefore still requires a posted Codex review before merge. The latest current-head review
request received the same Codex connector usage-limit response, so the mandatory review gate is not
satisfied. No production rollout occurred for #5412 and no rollback is needed for that PR.

## Open PR enumeration

- #5412, `feat(torghut): add renewal bond profit escrow`, is the only open Torghut quant runtime PR
  found in the current open PR set. It was selected as the high-impact item and held at the
  large-diff review gate.
- #5878 is open but belongs to `temporal-bun-sdk`, outside this Torghut quant release lane.
- #5767 and #5316 are automated release PRs outside the selected Torghut quant runtime path.

## PRs touched

- #5412: inspected mergeability, checks, comments, review threads, and diff size; updated the
  anchored `<!-- codex:progress -->` comment with the current no-go gate.
- #5880: verified the already-merged Torghut image promotion rolled out through GitOps and reached
  healthy workload readiness.
- This audit branch: refreshed `docs/torghut/rollouts/2026-05-07-torghut-quant-verify.md` and
  `/workspace/.agentrun/swarm/torghut-quant-verify.md` with the current release decision.

## Comments and conflicts resolved

- #5412 has no unresolved review threads and no posted GitHub reviews.
- #5412 is currently `mergeable=MERGEABLE` and `mergeStateStatus=CLEAN`.
- The active blocker is not a code conflict or failing check. The blocker is the missing Codex
  large-diff review.
- The latest current-head review request is
  https://github.com/proompteng/lab/pull/5412#issuecomment-4397819133.
- The connector response is still the Codex code-review usage-limit blocker:
  https://github.com/proompteng/lab/pull/5412#issuecomment-4397820407.
- No direct production mutations were made from the local shell. Promotion and rollback remain
  GitOps PR actions only.

## Merge outcomes

#5880 was already merged and was go for rollout:

- PR: https://github.com/proompteng/lab/pull/5880.
- Title: `chore(torghut): promote image 88021802`.
- Squash merge commit: `a291127d4ea604e2503a0ff6f94395c2cb549daf`.
- Source commit promoted by the image: `880218021dc63655d225416c1d953f59c088a1fb`.
- Promoted image digest:
  `sha256:8db8a40ee7f76c08aaa0689b55e145dfaf872248707a20fb38c005e0eabb42ab`.
- PR size: 24 additions and 24 deletions, below the large-diff Codex review threshold.

#5412 remains no-go for merge:

- PR: https://github.com/proompteng/lab/pull/5412.
- Current head: `4b5aa88b916b7d05862639606d62be753e6875f6`.
- Current inspected size: 5,915 additions and 453 deletions.
- Visible checks are green or skipped, including Torghut CI run `25500791581` and semantic checks.
- `gh pr checks 5412 -R proompteng/lab --required --watch --interval 10` reports no required checks
  configured on the branch.
- The PR exceeds the 1000-line mandatory Codex review threshold.
- No Codex review is posted. The latest connector response still reports Codex usage limits for code
  reviews.

## Validation

- PASS: NATS context soak was read before action from `.codex-nats-context.json`; it contained no
  fetched teammate messages for `workflow.general.>`.
- PASS: `/usr/local/bin/codex-nats-publish --kind status --channel general ... --publish-general`
  published live release updates.
- PASS: `gh pr list -R proompteng/lab --state open --limit 100 --json ...`; enumerated open PRs and
  selected #5412 as the only open Torghut quant runtime PR.
- PASS: `gh pr view 5412 -R proompteng/lab --json ...`; confirmed `MERGEABLE`, `CLEAN`, 5,915
  additions, 453 deletions, 25 changed files, and no reviews.
- PASS: GraphQL review-thread query for #5412 returned no review threads.
- PASS: `gh pr checks 5412 -R proompteng/lab`; all visible checks were passing or skipped.
- PASS: `gh pr checks 5412 -R proompteng/lab --required --watch --interval 10`; no required checks
  were reported for the branch.
- PASS: `gh pr view 5880 -R proompteng/lab --json ...`; confirmed #5880 merged at
  `a291127d4ea604e2503a0ff6f94395c2cb549daf`.
- PASS: Kubernetes context was bootstrapped to `in-cluster` using the service account token and CA;
  `kubectl auth whoami` returned `system:serviceaccount:agents:agents-sa`.
- PASS: `kubectl get app -n argocd torghut torghut-options symphony-torghut ...`; all three apps
  reached Synced and Healthy at revision `a291127d4ea604e2503a0ff6f94395c2cb549daf`.
- PASS: `kubectl get deploy -n torghut ...`; `torghut-00267-deployment`,
  `torghut-sim-00367-deployment`, `torghut-options-catalog`, and `torghut-options-enricher` were
  ready on digest `sha256:8db8a40ee7f76c08aaa0689b55e145dfaf872248707a20fb38c005e0eabb42ab`.
- PASS: Recent events showed transient startup/readiness probe warnings followed by
  `RevisionReady` and `LatestReadyUpdate` for `torghut-00267` and `torghut-sim-00367`.

## Deployment evidence

GitOps state after #5880:

- `torghut`: Synced / Healthy at revision `a291127d4ea604e2503a0ff6f94395c2cb549daf`, operation
  phase `Succeeded`, finished at 2026-05-07T14:29:06Z.
- `torghut-options`: Synced / Healthy at revision `a291127d4ea604e2503a0ff6f94395c2cb549daf`,
  operation phase `Succeeded`, finished at 2026-05-07T14:24:41Z.
- `symphony-torghut`: Synced / Healthy at revision `a291127d4ea604e2503a0ff6f94395c2cb549daf`,
  operation phase `Succeeded`.

Workload readiness:

- `torghut-00267-deployment`: 1/1 ready on digest
  `sha256:8db8a40ee7f76c08aaa0689b55e145dfaf872248707a20fb38c005e0eabb42ab`.
- `torghut-sim-00367-deployment`: 1/1 ready on the same digest.
- `torghut-options-catalog`: 1/1 ready on the same digest.
- `torghut-options-enricher`: 1/1 ready on the same digest.

Event and pod evidence:

- `torghut-00267-deployment-7b6bb45b4f-tjkzg`: Running, containers ready `true,true`, zero restarts.
- `torghut-sim-00367-deployment-6dd58f6856-2ztl8`: Running, containers ready `true,true`, zero
  restarts.
- `torghut-options-catalog-59f59f8d66-ddds5`: Running, ready `true`, zero restarts.
- `torghut-options-enricher-fdd8b686c-4d979`: Running, ready `true`, zero restarts.
- Old `torghut-sim-00366` was terminating after the new revision became ready, which is expected
  during Knative revision replacement.

## Risks

- #5412 remains the primary release risk. It must stay unmerged until Codex review capacity is
  restored and the required large-diff review posts with all resulting threads resolved, or until a
  maintainer explicitly waives that gate.
- Live rollout health is green for #5880, but #5412 has not affected production.
- The old failed pod `torghut-whitepaper-autoresearch-profit-target-8r6w6` predates this rollout and
  remained isolated from the #5880 runtime promotion. It is residual workflow debt, not a rollback
  trigger for #5880.
- Recent startup/readiness warnings on new Knative pods resolved into ready revisions. Reappearance
  of those warnings with stuck readiness would be a rollback trigger.
- ClickHouse still emits multiple-PDB warnings in the namespace. This is cluster hygiene debt and was
  not caused by #5880 or #5412.

## Rollback path

- For #5880: open a GitOps PR reverting `a291127d4ea604e2503a0ff6f94395c2cb549daf`, or revert the
  image-reference changes back to the previous Torghut digest, then let Argo CD reconcile. Do not
  mutate production directly outside an emergency.
- If source commit `880218021dc63655d225416c1d953f59c088a1fb` regresses, revert that source change
  and promote the last known-good image through the normal Torghut release workflow.
- Rollback triggers: `torghut` or `torghut-options` becomes Degraded or stuck OutOfSync, active
  Torghut pods lose readiness, new revisions fail startup/readiness probes without recovery, or
  runtime behavior regresses beyond known capital/feature gates.
- For #5412: no rollback is required because #5412 was not merged and no #5412 production rollout
  occurred.

## Next action

Keep #5412 open and blocked. The smallest unblocker is restored Codex review capacity, or an explicit
maintainer waiver of the large-diff review gate. After the review posts, resolve any threads, refresh
the PR against current `main`, recheck all required and visible checks, squash-merge only after green,
and repeat GitOps/workload/event verification.
