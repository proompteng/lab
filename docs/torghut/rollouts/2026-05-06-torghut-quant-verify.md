# Torghut quant verifier release gate - 2026-05-06

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-06T18:00Z

## Owner update message

Torghut rollout state is healthy for the merged production path and no-go for #5412.

#5719 promoted the `4c330ce9` Torghut image and was squash-merged at
`d2153825eeb49712d62f6b7d0e1c4238a74cb312` after PR checks passed. Mainline `torghut-ci`,
`torghut-post-deploy-verify`, `argo-lint`, and `kubeconform` also passed on the merge commit. Argo
reports `torghut`, `torghut-options`, and `symphony-torghut` Synced/Healthy, and the latest Torghut
runtime pods are ready on digest `sha256:61e18bb5370ecb76cf06e44b7883ed3b2e5557d0de1c870ba0ce8a9d98c8a3f9`.
Service probes from inside the cluster returned HTTP 200.

#5412 remains held. It is clean and green on head `2980d189333b297c5b29bc321895452044dc57da`, but it
is a 4,239-line diff and the required Codex review has not posted. The most recent connector response
to the review request was the Codex code-review usage-limit blocker, and a fresh release-gate review
request was posted at 2026-05-06T17:56Z with no posted review observed by this refresh. The smallest
unblocker is restored Codex review capacity or an explicit maintainer waiver of the large-diff review
gate.

## Open PR enumeration

- #5412, `feat(torghut): add proof leases and evidence gates`, is the remaining open Torghut quant
  runtime PR. It is selected for release review and held.
- #5719, `chore(torghut): promote image 4c330ce9`, was the latest Torghut GitOps promotion. It is
  merged and rolled out healthy.
- #5316, `chore(release/735ddbc): automated release PR`, is still open but was not selected because
  it only bumps the docs image tag, not Torghut.
- #5718, `docs(torghut): refresh quant verify release gate`, is the prior verifier audit PR for this
  branch and is already merged.

## Gate decisions

#5412 remains no-go for merge:

- GitHub reports `mergeable=MERGEABLE` and `mergeStateStatus=CLEAN`.
- Current head: `2980d189333b297c5b29bc321895452044dc57da`.
- Size: 4,211 additions and 28 deletions across 23 files.
- Visible checks are pass or intentionally skipped: Torghut Pyright, Torghut quality signals,
  Torghut bytecode + pytest + coverage, argo-lint, kubeconform, changed-files, Semantic PR title,
  and Semantic commit messages.
- Reviews: zero posted reviews and zero review threads.
- Latest completed connector blocker:
  https://github.com/proompteng/lab/pull/5412#issuecomment-4390254526.
- Fresh release-gate Codex review request:
  https://github.com/proompteng/lab/pull/5412#issuecomment-4390641593.

#5719 was go for merge:

- Size: 22 additions and 22 deletions across 12 GitOps manifests.
- Required PR checks passed: argo-lint, kubeconform, Torghut Pyright, Torghut quality signals,
  Torghut bytecode + pytest + coverage, Semantic PR title, Semantic commit messages, and
  `torghut-deploy-automerge` enable.
- Mainline checks on merge commit `d2153825eeb49712d62f6b7d0e1c4238a74cb312` passed:
  `torghut-ci`, `torghut-post-deploy-verify`, `argo-lint`, `kubeconform`, and `jangar-release`.
- Review threads: zero.
- Squash merge commit: `d2153825eeb49712d62f6b7d0e1c4238a74cb312`.

## PRs touched

- #5412: inspected, current checks verified, progress comment refreshed, Codex review re-requested,
  and held unmerged.
- #5719: inspected as the latest merged Torghut promotion and verified through GitHub, Argo, workload,
  event, and runtime probe signals.
- #5316: inspected and explicitly not selected because it is a docs release PR.

## Comments and conflicts

- #5412 progress comment remains anchored with `<!-- codex:progress -->` and records the current
  no-go gate.
- #5412 has no unresolved code review threads and no GitHub review comments.
- The fresh #5412 Codex review request has not produced a posted review as of this refresh. The prior
  connector response remains the usage-limit blocker.
- No merge conflicts were present on #5412 or #5719 during this refresh.

## Validation

- PASS: `/usr/local/bin/codex-nats-soak`; refreshed `.codex-nats-context.json`, with no prior
  general-channel messages returned for this run.
- PASS: `gh pr list -R proompteng/lab --state open --limit 100 --json ...`; enumerated open PRs and
  selected #5412 only for Torghut release gating.
- PASS: `gh pr checks 5412 -R proompteng/lab`; visible checks are passing or skipped.
- PASS: `gh pr checks 5719 -R proompteng/lab`; required PR checks passed before merge.
- PASS: `gh run list -R proompteng/lab --branch main --commit d2153825eeb49712d62f6b7d0e1c4238a74cb312`;
  mainline Torghut post-merge checks passed.
- PASS: `kubectl -n argocd get application torghut torghut-options symphony-torghut root -o json`;
  Torghut child apps are Synced/Healthy.
- PASS: `kubectl -n torghut get deployments -o wide`; active desired-replica Torghut workloads are
  ready.
- PASS: `kubectl -n torghut get pods --field-selector=status.phase!=Running,status.phase!=Succeeded -o wide`;
  no non-running or non-succeeded pods.
- PASS: in-cluster DNS probes from the runner pod returned HTTP 200 for `/healthz`,
  `/trading/status`, `torghut-sim` `/readyz`, options catalog `/healthz`, and options enricher
  `/readyz`.
- BLOCKED: direct `kubectl exec` probes and Knative `ksvc` listing are not allowed for
  `system:serviceaccount:agents:agents-sa`; service health was verified with Argo resource health,
  deployments, pods, events, and in-cluster HTTP probes instead.

## Deployment evidence

GitOps state:

- `torghut`: Synced / Healthy at current compared revision `0ca4999af2f521a330a661fbd09473c18b02a0c8`;
  latest Torghut operation synced `d2153825eeb49712d62f6b7d0e1c4238a74cb312` successfully at
  2026-05-06T17:14:22Z.
- `torghut-options`: Synced / Healthy at current compared revision
  `0ca4999af2f521a330a661fbd09473c18b02a0c8`; latest Torghut options operation synced
  `d2153825eeb49712d62f6b7d0e1c4238a74cb312` successfully at 2026-05-06T17:11:49Z.
- `symphony-torghut`: Synced / Healthy at current compared revision
  `0ca4999af2f521a330a661fbd09473c18b02a0c8`.
- `root`: OutOfSync / Healthy at current compared revision
  `0ca4999af2f521a330a661fbd09473c18b02a0c8`; this remains root ApplicationSet drift, not Torghut
  child-app rollout failure.

Workload readiness:

- `torghut-00241-deployment`: 1 ready / 1 available / 1 desired on Torghut digest
  `sha256:61e18bb5370ecb76cf06e44b7883ed3b2e5557d0de1c870ba0ce8a9d98c8a3f9`.
- `torghut-sim-00338-deployment`: 1 ready / 1 available / 1 desired on the same Torghut digest.
- `torghut-options-catalog`: 1 ready / 1 available / 1 desired on the same Torghut digest.
- `torghut-options-enricher`: 1 ready / 1 available / 1 desired on the same Torghut digest.
- Matching pods were Running, ready, and had zero restarts.
- Runtime metadata on active Torghut and Torghut-sim deployments reports
  `TORGHUT_VERSION=v0.568.5-216-g4c330ce9d` and
  `TORGHUT_COMMIT=4c330ce9d9a30c7318c3737eb83183c0afb732c2`.

Runtime probes:

- `http://torghut.torghut.svc.cluster.local/healthz`: HTTP 200, `status=ok`.
- `http://torghut.torghut.svc.cluster.local/trading/status`: HTTP 200,
  `build.commit=4c330ce9d9a30c7318c3737eb83183c0afb732c2`,
  `build.active_revision=torghut-00241`, and `live_submission_gate.allowed=false` with
  `simple_submit_disabled`.
- `http://torghut-sim.torghut.svc.cluster.local/readyz`: HTTP 200.
- `http://torghut-options-catalog.torghut.svc.cluster.local/healthz`: HTTP 200.
- `http://torghut-options-enricher.torghut.svc.cluster.local/readyz`: HTTP 200.

Recent event risks:

- Recent warning events during rollout were transient startup/readiness probes for new Torghut and
  Torghut-sim pods before readiness.
- `torghut-ta-sim` emitted normal suspend/resume reconciliation events and reached Running; its
  runtime-ready AnalysisRun succeeded.
- Older Knative cleanup warnings for stale `torghut-sim-00332` resources appeared during revision
  churn, while current `torghut-sim-00338` is ready.
- ClickHouse still emits `MultiplePodDisruptionBudgets` warnings. This is cluster hygiene debt, not
  a Torghut application readiness blocker.

## Risk

- #5412 is the main release risk. It must stay unmerged until Codex review capacity is restored and
  the required large-diff review posts, with all resulting threads resolved, or a maintainer
  explicitly waives the large-diff gate.
- Root Argo application drift remains a GitOps hygiene risk. Torghut child apps are healthy, so it is
  not a rollback trigger for the current rollout.
- Live capital remains intentionally shadow-blocked by `simple_submit_disabled`; this healthy rollout
  does not imply live capital enablement.
- The runner service account cannot list Knative Services or exec into Torghut pods. Release health
  was established through allowed read surfaces plus direct in-cluster HTTP requests from the runner.

## Rollback path

- For #5719: open a GitOps PR reverting `d2153825eeb49712d62f6b7d0e1c4238a74cb312`, or reverting
  the 12 image-reference changes from #5719 back to the previous healthy digest, then let Argo CD
  reconcile. Do not mutate production directly outside an emergency.
- If the runtime change behind the promoted image regresses, revert `4c330ce9d9a30c7318c3737eb83183c0afb732c2`
  and promote the previous healthy image through the same GitOps PR path.
- Rollback triggers: `torghut` or `torghut-options` becomes Degraded or stuck OutOfSync, the
  post-deploy verification workflow fails, active Torghut pods lose readiness, runtime probes stop
  returning HTTP 200, or runtime behavior regresses beyond the documented live-capital shadow gate.
- For #5412: no runtime rollback is required because it was not merged.

## Next action

Keep #5412 open and blocked. The smallest unblocker is restored Codex review capacity, or an explicit
maintainer waiver of the large-diff review gate. After the review posts, resolve any threads, refresh
against current `main`, wait for all required checks, squash-merge, and repeat GitOps/workload/event
verification.
