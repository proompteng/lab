# Jangar Control Plane Release Handoff - 2026-05-12

Owner update message:

Merge gate is split. #6197 merged as `4a3e31192000f15d6eb8de1745ec47ebf0cf94fb` after clean checks and no review
threads. #6202 merged as `49e1dc8edce0663cd21326812fe10e79926bc3c4` and is waiting on post-merge
build/integration/promotion. #5889 remains unmerged: current head `d375e6083020136f67577c0f8d5d50f7aab24f0a` is a
4,052-line direct control-plane diff with pending hosted checks. The latest posted Codex review targets previous head
`ddeb467f2a`, so the mandatory current-head review gate is still open. Live Jangar baseline is healthy at latest main
`35b587bb960293569baf16777d16656d2d60af57`, but #6202's code image is not proven because `agents-ci` is in progress and
the Jangar image build/promotion workflows are queued. #5889 is not live.

## PRs touched

- #6197 `docs(jangar): define stage clearance launch governor`
  - Merged at 2026-05-12T17:02:04Z.
  - Merge commit: `4a3e31192000f15d6eb8de1745ec47ebf0cf94fb`.
  - Checks: semantic commit and PR title checks passed; deploy-automerge enable jobs skipped.
- #6202 `fix(jangar): accept market-context finalize wrappers`
  - Merged at 2026-05-12T17:17:47Z.
  - Merge commit: `49e1dc8edce0663cd21326812fe10e79926bc3c4`.
  - Checks: PR checks are green except `agents-ci / integration`, which is pending. Main-branch `agents-ci` is in
    progress, and main-branch Jangar image build/promotion workflows are queued.
- #5889 `feat(jangar): add repair and action custody receipts`
  - No-go. Not merged.
  - Current head: `d375e6083020136f67577c0f8d5d50f7aab24f0a`.
  - Blockers: pending hosted checks and mandatory current-head large-diff Codex review. The latest posted Codex review
    targets previous head `ddeb467f2a`.

## Comments and conflicts

- #6197 had no review threads or conflict blockers when checked.
- #5889 has no review threads, but the progress comment now records the current no-go gate.
- No production manifests were applied directly from this shell.

## Deployment evidence

- Argo `jangar` and `agents`: Synced, Healthy, operation Succeeded, revision
  `35b587bb960293569baf16777d16656d2d60af57`.
- `deployment/jangar`, `deployment/agents`, and `deployment/agents-controllers` rolled out successfully.
- `service/jangar` endpoint: `10.244.5.174:8080`; `/health` returned `status=ok`.
- `deployment/agents` and `deployment/agents-controllers` are Ready with current endpoints. Service proxy to agents is
  forbidden for this service account, so readiness proof is rollout status, pod readiness, and EndpointSlices.

## Metrics and risk

- `failed_agentrun_rate`: scoped to `swarm.proompteng.ai/name=jangar-control-plane`, the observed window has
  6 succeeded, 5 running, and 0 failed AgentRuns.
- `ready_status_truth`: healthy baseline recorded separately from #5889, which is not live.
- `pr_to_rollout_latency`: #6197 reached merge quickly; #6202 is waiting on post-merge checks and promotion; #5889 is
  blocked by review capacity and current-head CI.
- `manual_intervention_count`: zero production workload mutations from this shell.
- `handoff_evidence_quality`: repo rollout doc, progress comment, NATS updates, mission ledger, and verify artifact are
  aligned.
- Residual risk: wider agents namespace AgentRuns include Torghut market-context failures; they are outside this
  selected Jangar control-plane gate but remain visible background risk.

## Rollback path

- Revert #6197 merge commit `4a3e31192000f15d6eb8de1745ec47ebf0cf94fb` if the new docs/design misstate launch
  governance.
- #5889 has no runtime rollback from this pass because it did not merge.
- If #5889 later merges and regresses, revert that PR or stop consuming `repair_warrant_exchange`.
- Keep rollback GitOps-first; do not mutate production workloads directly for normal rollback.

## Next action

Keep #5889 held until hosted checks are green, current main is included, a current-head Codex review posts, and all
review threads are resolved. Wait for #6202 post-merge build/promotion and rollout verification before closing the
Jangar release gate; current blocker is main-branch `agents-ci` plus queued Jangar image build/promotion.
