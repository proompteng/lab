# Jangar control-plane release verification - 2026-05-13

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane-verify`
Release engineer: Marco Silva

## Owner update message

Rollout state is green for the selected Jangar control-plane release lane. I moved five direct Jangar PRs through the
release gates and verified their GitOps rollouts: #6324 consumer evidence leases, #6330 stage credit ledger, #6339
source-serving verdict status, #6343 Torghut repair-bid admission, and #6349 controller heartbeat witness preservation.
Each merged PR had green required checks before merge; each production promotion completed through a release PR and
post-deploy verifier; latest live Jangar workloads are on image `5d89ac24`.

The business metric improved is `ready_status_truth`, with supporting impact on `failed_agentrun_rate`,
`pr_to_rollout_latency`, `manual_intervention_count`, and `handoff_evidence_quality`. The final runtime state is
intentionally conservative rather than fully open for material actions: `serve_readonly` and `torghut_observe` are
allowed, while dispatch, merge, paper, and live actions remain held or blocked until Torghut route and repair-settlement
receipts plus source-serving CI/image receipts exist. The observed Jangar control-plane AgentRuns since
2026-05-13T03:30Z were 6 succeeded, 1 running, and 0 failed.

## Governing requirements

- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`: verify stages must merge only green PRs and
  prove Argo sync, workload readiness, and service health after rollout.
- `docs/agents/designs/129-jangar-consumer-evidence-leases-and-readiness-decoupling-2026-05-06.md`: governs #6324.
- `docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md`: governs #6330.
- `docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`: governs #6339.
- `docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`: governs #6343.
- `docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md` and
  `docs/agents/designs/121-jangar-material-action-repair-clearing-lane-and-profit-proof-ledger-2026-05-06.md`:
  govern #6349.

## PRs touched

- #6324 `feat(jangar): add consumer evidence leases`
  - Fixed blockers: resolved stale architecture inventory, rebase conflicts, and the Jangar module-size violation by
    moving degraded-component status construction into
    `services/jangar/src/server/control-plane-status-degraded-components.ts`.
  - Merge outcome: merged at 2026-05-13T04:51:12Z as
    `6596b581321ab05168ed663a506e10e3893043d7`.
  - Promotion: #6335 `chore(jangar): promote image 6596b581`, merged as
    `ab4b324b958184c89c3e417a881e192d04ab38e7`.
  - Post-deploy verifier: `25779478472`, success from 2026-05-13T05:04:41Z to 05:08:27Z.
- #6330 `feat(jangar): add stage credit ledger read model`
  - Fixed blockers: rebased onto #6324/main, preserved consumer-evidence imports and the degraded-component helper,
    refreshed architecture inventory, and kept the branch mergeable.
  - Merge outcome: merged at 2026-05-13T05:11:23Z as
    `97a20bc4f6d2b6d6198372870795ad8ddce54a74`.
  - Promotion: #6342 `chore(jangar): promote image 97a20bc4`, merged as
    `a51a7f378e13f30a2a80f5b2f7c38278d5305843`.
  - Post-deploy verifier: `25780107631`, success from 2026-05-13T05:23:42Z to 05:29:57Z.
- #6339 `feat(jangar): add source-serving verdict status`
  - Selected because it made source-serving readiness truthful by surfacing allow/hold/block verdicts.
  - Merge outcome: merged at 2026-05-13T05:41:19Z as
    `99063cb4c14e0c22633f6d2a63391ca59ee6a6b3`.
  - Promotion: #6347 `chore(jangar): promote image 99063cb4`, merged as
    `828125cca320a8f5eb4311bb3b05389d71bed615`.
  - Post-deploy verifier: `25781202876`, success from 2026-05-13T05:54:53Z to 05:59:31Z.
- #6343 `feat(jangar): admit settled torghut repair lots`
  - Selected after #6339 because the live source-serving verdicts named missing
    `repair_bid_settlement_ledger` as a blocker.
  - Merge outcome: merged at 2026-05-13T06:04:51Z as
    `f18b66fdbc4e55bc2ef7177fc17fd86ea8a491b2`.
  - Promotion: #6350 `chore(jangar): promote image f18b66fd`, merged as
    `458bda93588b5954b051b34c0f1c70c357eeeca3`.
  - Post-deploy verifier: `25782031603`, success from 2026-05-13T06:17:37Z to 06:23:38Z.
- #6349 `fix(jangar): preserve controller heartbeat witnesses`
  - Selected after #6343 because live status still showed controller heartbeat truth as a runtime blocker.
  - Merge outcome: merged at 2026-05-13T06:28:30Z as
    `5d89ac24819d84632873caf046cd0a1ff111db95`.
  - Promotion: #6355 `chore(jangar): promote image 5d89ac24`, merged as
    `e1203140c04845107a3644b8d67215006d3c7d89`.
  - Post-deploy verifier: `25782868775`, success from 2026-05-13T06:39:29Z to 06:41:23Z.
- Earlier Jangar/Torghut supporting PRs were also tracked in the release lane:
  #6313, #6314, #6320, #6319, and #6326 were merged and rolled forward before the final Jangar lane settled.
- Current open PR enumeration after #6349 rollout:
  #6354 is Torghut quant rollout documentation, and #6219/#6215/#6214/#6210/#6206/#6200 are stale release PRs.
  No direct open Jangar control-plane implementation PR remains selected.

## Comments and conflicts

- Progress comments were kept current with
  `services/jangar/scripts/codex/codex-progress-comment.ts` for #6324, #6330, #6339, #6343, and #6349.
- #6324 had rebase and module-size blockers that were fixed before merge.
- #6330 had rebase/import conflicts against #6324 that were fixed before merge.
- #6339, #6343, and #6349 had no blocking review threads when selected; each was held until required checks were green.
- No direct production mutation was made from this shell. Promotion was via merged PRs and GitOps reconciliation.

## Deployment evidence

- Final Argo state after #6355:
  - `jangar`: Synced, Healthy, operation Succeeded, revision
    `e1203140c04845107a3644b8d67215006d3c7d89`.
  - `agents`: Synced, Healthy, operation Succeeded, revision
    `e1203140c04845107a3644b8d67215006d3c7d89`.
- Final workload state:
  - `deployment/jangar -n jangar`: 1/1 available on
    `registry.ide-newton.ts.net/lab/jangar:5d89ac24@sha256:e677e2e203bc7583ac9274f798d54e95398afff2d927d04632ff5a1a978fcf6b`.
  - `deployment/agents -n agents`: 1/1 available on
    `registry.ide-newton.ts.net/lab/jangar-control-plane:5d89ac24@sha256:d5d7dd9aa26703eb2a2100b05a7cf2fbb92e1a89151bb0c4355f18f2681c7835`.
  - `deployment/agents-controllers -n agents`: 2/2 available on
    `registry.ide-newton.ts.net/lab/jangar:5d89ac24@sha256:e677e2e203bc7583ac9274f798d54e95398afff2d927d04632ff5a1a978fcf6b`.
- Service health:
  - `http://jangar.jangar.svc.cluster.local/health`: `status=ok`.
  - `http://agents.agents.svc.cluster.local/ready`: `status=ok`, leader election held, memory provider healthy,
    runtime kits healthy, rollout health healthy.
- Control-plane status after #6349:
  - `source_serving_contract_verdict_exchange.source_sha` is
    `5d89ac24819d84632873caf046cd0a1ff111db95`.
  - Source-serving verdicts are mode `observe`, status `block`; `serve_readonly` is allowed, dispatch/merge/paper are
    held, and live support is blocked.
  - `repair_bid_admission` is mode `observe`, status `block`, with reason codes
    `torghut_repair_bid_settlement_missing` and `torghut_repair_bid_settlement_not_current`.
  - `ready_action_exchange` allows `serve_readonly` and `torghut_observe`, holds
    `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`, and blocks
    `live_micro_canary` plus `live_scale`.
- Events:
  - Recent agents and Jangar warnings were rollout-time readiness probe failures on old or newly starting pods.
  - No current rollout was left degraded; the final Argo and deployment states are healthy.

## Metrics and value gates

- `failed_agentrun_rate`: scoped Jangar control-plane AgentRuns created since 2026-05-13T03:30Z show
  6 succeeded, 1 running, and 0 failed.
- `pr_to_rollout_latency`: #6349 merged at 2026-05-13T06:28:30Z and its final post-deploy verifier completed at
  2026-05-13T06:41:23Z. Earlier selected PRs followed the same green-check to promotion to verifier path.
- `ready_status_truth`: improved by adding consumer leases, stage credit ledger, source-serving verdicts,
  repair-bid admission, and controller-witness preservation. The final surface is not falsely green for material
  actions; it names the missing evidence.
- `manual_intervention_count`: zero direct cluster mutations from the local shell.
- `handoff_evidence_quality`: PR progress comments, this rollout doc, the mission ledger, the verify handoff, and NATS
  updates carry the same merge/rollout/runtime blocker evidence.

## Rollback path

- Roll back through GitOps by reverting the relevant feature PR and its latest promotion PR, not by mutating live
  workloads directly.
- Latest full image rollback target: revert #6355 or promote the previous known-good Jangar image from #6350
  (`f18b66fd`) if the #6349 heartbeat witness repair regresses.
- Feature-level rollback options:
  - Revert #6349 to restore the prior heartbeat publisher behavior.
  - Revert #6343 to remove repair-bid admission and fall back to the prior Torghut consumer-evidence status.
  - Revert #6339 to remove source-serving verdict status if downstream consumers mishandle observe/block verdicts.
  - Revert #6330 or #6324 if their read models regress status payload generation.
- Runtime safety fallback is already conservative: dispatch, paper, and live actions are held or blocked while Torghut
  route/settlement evidence and source-serving receipts are missing.

## Next action

Smallest remaining blocker: produce current Torghut route warrant, repair-bid settlement ledger, and source-serving
CI/image receipts so the source-serving verdict exchange and repair-bid admission can move from observe/block toward
bounded repair admission. Until then, keep material actions held and use `serve_readonly` plus `torghut_observe` only.
