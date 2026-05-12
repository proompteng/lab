# Jangar control-plane release verification - 2026-05-12

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane-verify`
Release engineer: Marco Silva

## Owner update message

Merge gate is split. #6197, `docs(jangar): define stage clearance launch governor`, is merged as
`4a3e31192000f15d6eb8de1745ec47ebf0cf94fb`; it was a 770-line docs/design PR with clean merge state, no review
threads, and only passing or skipped checks. #5889, `feat(jangar): add repair and action custody receipts`, remains a
no-go: current head `d375e6083020136f67577c0f8d5d50f7aab24f0a` is mergeable but unstable while hosted checks run, is
4,052 changed lines, and the latest posted Codex review targets previous head `ddeb467f2a`, not the current head.

Live Jangar baseline is read-only healthy at latest main `35b587bb960293569baf16777d16656d2d60af57`, but #6202's code
image is not proven because main-branch `agents-ci` is still running and the Jangar image build/promotion workflows are
still queued. Argo reports `jangar` and `agents` Synced/Healthy at revision
`35b587bb960293569baf16777d16656d2d60af57`;
`deployment/jangar`, `deployment/agents`, and `deployment/agents-controllers` are rolled out; `service/jangar`
`/health` returns `status=ok`; Jangar control-plane AgentRuns created in the observed window show 6 succeeded,
5 running, and 0 failed. The wider
agents namespace has Torghut market-context failures, so the Jangar metric evidence is scoped by
`swarm.proompteng.ai/name=jangar-control-plane`.

## PRs touched

- #6197 `docs(jangar): define stage clearance launch governor`
  - Selected because it is Jangar control-plane plan/design work for launch governance and handoff evidence quality.
  - Merge outcome: merged at 2026-05-12T17:02:04Z as `4a3e31192000f15d6eb8de1745ec47ebf0cf94fb`.
  - Checks before merge: `Lint commit messages` passed, `Validate PR title` passed, deploy-automerge enable jobs
    skipped intentionally.
  - Diff size: 770 changed lines, below the mandatory large-diff Codex review gate.
- #6202 `fix(jangar): accept market-context finalize wrappers`
  - Merged at 2026-05-12T17:17:47Z as `49e1dc8edce0663cd21326812fe10e79926bc3c4`.
  - Selected after merge because it is a direct Jangar fix for market-context AgentRun finalize wrapper handling.
  - PR checks are green except `agents-ci / integration`, which is pending. Main-branch `agents-ci` is in progress, and
    `jangar-build-push` plus `Docker Build and Push` are queued for the merge commit.
  - Runtime rollout evidence for the #6202 code image is pending; active workloads still use image tag `05a6939b`.
- #5889 `feat(jangar): add repair and action custody receipts`
  - Selected as the only direct Jangar control-plane implementation PR.
  - Merge outcome: no-go, not merged.
  - Current head: `d375e6083020136f67577c0f8d5d50f7aab24f0a`.
  - Current blocker: hosted checks are still unstable/pending, and the PR is 4,052 changed lines. The latest posted
    Codex review targets previous head `ddeb467f2a`, so the mandatory current-head review gate is still open.
- #6196, #6188, #6201, #6203, #6205, #6207, and #6199
  - Merged through automation while this gate was active and are tracked as concurrent main-branch rollout risk, not
    selected Jangar control-plane PRs.
- #6208, #6206, #6200, and #6127
  - Enumerated as open app/release/Torghut-scoped PRs and not selected for this Jangar control-plane release gate.

## Comments and conflicts

- #6197 had no review threads and no inline comments when checked. It merged before the manual merge command completed.
- #5889 has no review threads or inline comments, but the large-diff review gate is unresolved.
- The #5889 progress comment was refreshed with `services/jangar/scripts/codex/codex-progress-comment.ts`.
- No direct production mutations were made from the local shell.

## Deployment evidence

- #6197 was docs/design only. It did not require a Jangar image promotion, but the GitOps baseline was checked after
  merge.
- #6202 is not yet proven rolled out. Its post-merge build, integration, and promotion path is still pending.
- Argo applications:
  - `jangar`: Synced, Healthy, operation Succeeded, revision `35b587bb960293569baf16777d16656d2d60af57`.
  - `agents`: Synced, Healthy, operation Succeeded, revision `35b587bb960293569baf16777d16656d2d60af57`.
  - `torghut`: Synced, Degraded, operation Succeeded, revision `35b587bb960293569baf16777d16656d2d60af57`.
  - `torghut-options`: Synced, Healthy, operation Succeeded, revision `35b587bb960293569baf16777d16656d2d60af57`.
- Rollouts:
  - `deployment/jangar -n jangar`: successfully rolled out.
  - `deployment/agents -n agents`: successfully rolled out.
  - `deployment/agents-controllers -n agents`: successfully rolled out.
- Active images:
  - `deployment/jangar`: `registry.ide-newton.ts.net/lab/jangar:05a6939b@sha256:8eabf940f5834ca5b834a5fb18ac7b9bfd3af4e768b3b3753f94ded39731771f`.
  - `deployment/agents`: `registry.ide-newton.ts.net/lab/jangar-control-plane:05a6939b@sha256:f4d3f741ad107d20040cb624624507cc56d41e87c65431c473ae60e852522ef1`.
  - `deployment/agents-controllers`: `registry.ide-newton.ts.net/lab/jangar:05a6939b@sha256:8eabf940f5834ca5b834a5fb18ac7b9bfd3af4e768b3b3753f94ded39731771f`.
- Service readiness:
  - `service/jangar` has endpoint `10.244.5.174:8080`.
  - Jangar service proxy `/health` returned `{"status":"ok","service":"jangar"}`.
  - Agents service proxy from this service account is forbidden, so agents service health proof is rollout status,
    readiness, and endpoints.
- Events:
  - Jangar namespace warnings are from unrelated `bumba` and `symphony-jangar` image/startup issues, not
    `deployment/jangar`.
  - Agents recent events show the current verify worker and other scheduled jobs starting/completing; older scheduled
    job failures are represented in AgentRun status and are not evidence that the deployed controller pods are unready.
  - A concurrent Torghut promotion verifier for #6199 failed because `torghut` stayed Synced but Degraded through
    90 attempts. Rollback PRs #6204 and #6182 merged, but Torghut was still Degraded at the latest check.
    This is tracked as Torghut release risk, not a Jangar workload readiness failure.

## Metrics and risk

- `failed_agentrun_rate`: Jangar control-plane AgentRuns created since 2026-05-12T15:15Z show 6 succeeded, 5 running,
  and 0 failed. All-agent counts include Torghut market-context failures, so this gate keeps the Jangar metric scoped to
  the selected control-plane swarm.
- `pr_to_rollout_latency`: #6197 merged quickly once green. #6202 is waiting on post-merge build/integration and image
  promotion. #5889 is delayed by current-head CI and a current-head Codex review, not by local conflict repair.
- `ready_status_truth`: preserved by separating healthy baseline evidence from #5889, which is not live.
- `manual_intervention_count`: zero production workload mutations from this shell.
- `handoff_evidence_quality`: progress comment, rollout doc, swarm verify file, mission ledger, and NATS updates carry
  the same no-go/green-gate split.

## Rollback path

- #6197 is docs/design only. Roll back with a normal revert PR for merge commit
  `4a3e31192000f15d6eb8de1745ec47ebf0cf94fb` if the documentation misleads launch governance.
- #5889 has no runtime rollback from this pass because it did not merge.
- If #5889 later merges and regresses, revert the PR or stop consuming `repair_warrant_exchange`; no database,
  Kubernetes, broker, or direct cluster mutation is required.
- Use GitOps PRs for normal rollback. Do not mutate production workloads directly from a local shell.

## Next action

Smallest current blocker: #6202 post-merge `agents-ci` is in progress while `jangar-build-push` and
`Docker Build and Push` are queued, so the #6202 code image is not proven live. Keep #5889 held until hosted checks are
green and a current-head Codex review posts, then recheck mergeability, review threads, Argo sync, workload readiness,
and service health before any squash merge.
