# Jangar control-plane release verification - 2026-05-13

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane-verify`
Release engineer: Marco Silva

## Owner update message

Rollout state is green for the selected Jangar control-plane release slice. Source PR #6414,
`feat(jangar): add evidence pressure ledger`, merged as `07da331d95ca0ef2779108a00a877c5e718b2656`,
and promotion PR #6420, `chore(jangar): promote image 07da331d`, merged as
`3dbaa6d63cd21e6e082be094ab2c8ea1cecc1d40`.

The GitOps and workload rollout gate is green: Argo `jangar`, `agents`, and `torghut` are Synced/Healthy at
`3b7277516fd31a9d74916202c81d5610e56afc19`, which includes the #6420 promotion commit, and
`jangar-post-deploy-verify` run `25800868616` passed. Live `jangar`, `agents`, and `agents-controllers` workloads are
ready on image tag `07da331d`.

`jangar /health`, `jangar /ready`, and `agents /ready` returned HTTP 200. `/ready` reported
`execution_trust=healthy`, `torghut_consumer_evidence=current`, and a fresh `evidence_pressure_ledger` in observe mode
with calm watch backoff. The control-plane metric improved is `ready_status_truth`: the runtime now exposes the
evidence pressure ledger and watch-backoff posture directly on readiness/status, making merge and dispatch gates easier
to verify without inferring pressure from unrelated symptoms. `pr_to_rollout_latency` was 15m24s from source merge
(`2026-05-13T12:52:48Z`) to post-deploy verifier completion (`2026-05-13T13:08:12Z`).

## Governing requirements

- `docs/agents/designs/188-jangar-evidence-pressure-ledger-and-watch-backoff-governor-2026-05-13.md`: publish the
  Jangar evidence pressure ledger, watch-backoff policy, and deployer handoff in observe mode.
- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`: verify stages must merge only green PRs and
  prove Argo sync, workload readiness, and service health after rollout.
- Runtime acceptance contract: selected PRs must advance failed AgentRun reduction, PR-to-rollout latency,
  ready-status truth, manual-intervention reduction, or handoff evidence quality.
- GitOps safety requirement: no direct production mutation from the local shell; promotion happens through PR merge and
  Argo reconciliation.

## PRs touched

- #6414 `feat(jangar): add evidence pressure ledger`
  - Purpose: add `evidence_pressure_ledger` to control-plane status and `/ready`, including watch reason-code aging,
    pressure summaries, UI rendering, docs, and regressions.
  - Merge gate: non-draft, no review threads, no requested changes, CLEAN/MERGEABLE, and all visible checks green or
    intentionally skipped before merge.
  - Checks before merge: `jangar-ci / lint-and-typecheck / run`, `agents-ci / validate`, `agents-ci / integration`,
    `CI / check_changed_files`, semantic title, and semantic commits passed; unrelated matrix/deploy enable jobs were
    skipped.
  - Merge outcome: squash-merged at `2026-05-13T12:52:48Z` as
    `07da331d95ca0ef2779108a00a877c5e718b2656`.
  - Post-merge checks: `Docker Build and Push` run `25800308156`, `jangar-build-push` run `25800308052`,
    `agents-ci` run `25800308019`, and `jangar-release` run `25800808195` passed.
- #6420 `chore(jangar): promote image 07da331d`
  - Purpose: promote the #6414 image through GitOps.
  - Image tag: `07da331d`.
  - Jangar image digest: `sha256:d0a61187c54f063d6f3f875a6760b3202ff8f7733b2f7977ff06a39d1a3e3c90`.
  - Agents control-plane image digest:
    `sha256:ee5c618919f28cdb3f62440f0ef8b280ec18e2fb42b4d784b067af74f3927110`.
  - Promotion checks: `argo-lint / lint`, `kubeconform / validate`, `jangar-ci / lint-and-typecheck / run`, semantic
    title, semantic commits, and Jangar deploy automerge enable check passed; unrelated deploy enable jobs skipped.
  - Merge outcome: auto-merged at `2026-05-13T13:03:30Z` as
    `3dbaa6d63cd21e6e082be094ab2c8ea1cecc1d40`.
- #6399 `docs(jangar): record control-plane release gate`
  - Purpose: durable handoff for this verify run.
  - Change: replaced the earlier #6401/#6409 handoff with this bounded #6414/#6420 release record.

## Comments and conflicts

- #6414 had no review threads, no requested changes, and no merge conflicts when selected.
- #6420 had no review threads or requested changes. It auto-merged only after promotion checks were green.
- Progress comments were kept current with `services/jangar/scripts/codex/codex-progress-comment.ts` after merge and
  rollout state changed.
- No direct production mutation was made from this shell. All production changes landed through PR merge and GitOps.

## Deployment evidence

- Argo:
  - `jangar sync=Synced health=Healthy rev=3b7277516fd31a9d74916202c81d5610e56afc19`
  - `agents sync=Synced health=Healthy rev=3b7277516fd31a9d74916202c81d5610e56afc19`
  - `torghut sync=Synced health=Healthy rev=3b7277516fd31a9d74916202c81d5610e56afc19`
  - `symphony-jangar sync=Synced health=Healthy rev=07da331d95ca0ef2779108a00a877c5e718b2656`
  - `symphony-torghut sync=Synced health=Healthy rev=07da331d95ca0ef2779108a00a877c5e718b2656`
- Workloads:
  - `deployment/jangar -n jangar`: 1/1 ready, 0 restarts, image
    `registry.ide-newton.ts.net/lab/jangar:07da331d@sha256:d0a61187c54f063d6f3f875a6760b3202ff8f7733b2f7977ff06a39d1a3e3c90`.
  - `deployment/agents -n agents`: 1/1 ready, 0 restarts, image
    `registry.ide-newton.ts.net/lab/jangar-control-plane:07da331d@sha256:ee5c618919f28cdb3f62440f0ef8b280ec18e2fb42b4d784b067af74f3927110`.
  - `deployment/agents-controllers -n agents`: 2/2 ready, 0 restarts, image
    `registry.ide-newton.ts.net/lab/jangar:07da331d@sha256:d0a61187c54f063d6f3f875a6760b3202ff8f7733b2f7977ff06a39d1a3e3c90`.
- Service health:
  - `http://jangar.jangar.svc.cluster.local/health`: HTTP 200, `status=ok`.
  - `http://jangar.jangar.svc.cluster.local/ready`: HTTP 200, `status=ok`,
    `execution_trust=healthy`, `torghut_consumer_evidence=current`, `serving_runtime_proof_cells_healthy=true`.
  - `http://agents.agents.svc.cluster.local/ready`: HTTP 200, `status=ok`,
    `execution_trust=healthy`, `torghut_consumer_evidence=current`.
  - `evidence_pressure_ledger`: present on `/ready`, `schema_version=jangar.evidence-pressure-ledger.v1`,
    `evidence_mode=observe`, `watch_backoff_policy.state=calm`, and
    `observed_revision.source_head_sha=07da331d95ca0ef2779108a00a877c5e718b2656`.
- Post-deploy verifier: `jangar-post-deploy-verify` run `25800868616` passed at `2026-05-13T13:08:12Z`.
- Events: recent warning events were readiness probes during startup or replacement of old pods. Current Jangar and
  Agents deployment pods are Running and ready with zero restarts.

## Metrics and value gates

- `ready_status_truth`: improved. `/ready` now exposes an evidence pressure ledger bound to the merged source SHA, so
  release and scheduler decisions can read observe-mode pressure directly.
- `pr_to_rollout_latency`: 15m24s from #6414 source merge to post-deploy verifier completion; 4m42s from #6420
  promotion merge to post-deploy verifier completion.
- `failed_agentrun_rate`: expected improvement is fewer false verify-stage holds from missing pressure/watch-backoff
  context; the smallest runtime proof in this run is the healthy `/ready` ledger in observe/calm mode after promotion.
- `manual_intervention_count`: zero direct production mutations.
- `handoff_evidence_quality`: progress comments, this rollout doc, NATS updates, and swarm handoff artifacts carry the
  same merge, rollout, residual-risk, and rollback evidence.

## Risks and rollback path

- Residual risk: #6420 auto-merged after its required promotion checks were green while post-deploy verification was
  still running; final post-deploy verification passed before this handoff was recorded.
- Runtime risk is limited by observe mode. The new pressure ledger reports and gates visibility; it does not widen
  production mutation behavior by itself.
- Roll back through GitOps by reverting #6420 to restore the previous `f5ed7394` image. Revert #6414 only if the
  runtime regression follows the evidence-pressure-ledger implementation rather than the image promotion.
- Do not patch live Deployments directly except under an explicit emergency procedure; Argo should remain the source of
  truth.

## Next action

Monitor the next Jangar verify-stage windows for fewer pressure/watch-backoff ambiguity holds and confirm the ledger
stays fresh while `evidence_mode=observe`.
