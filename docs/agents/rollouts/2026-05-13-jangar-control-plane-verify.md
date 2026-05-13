# Jangar control-plane release verification - 2026-05-13

Swarm: `jangar-control-plane`
Branch: `codex/swarm-jangar-control-plane-verify`
Release engineer: Marco Silva

## Owner update message

Rollout state is healthy for the selected Jangar source release, but the release gate needed a follow-up test fix before
the promotion check history could be made green. Source PR #6440, `feat(jangar): add account-scoped quant witness`,
merged as `590379886ae32e68013204094f67660b3879c4fe`. Jangar promotion PR #6446 promoted that image as `59037988`,
and follow-on promotion PR #6447 promoted current main as `146bbce5`.

The GitOps and workload rollout gate is green for #6447: Argo `jangar`, `agents`, and `torghut` are Synced/Healthy at
`fc0aaebeddd92dcdbca933aa03426bd8eb630736`; `jangar-post-deploy-verify` run `25811518735` passed; and the live
`jangar`, `agents`, and `agents-controllers` deployments are ready on tag `146bbce5`.

The remaining blocker from the selected release slice was CI-only: `jangar-ci / lint-and-typecheck` failed on #6446 and
#6447 because the account-witness regression used fixed fixture timestamps while reading the live wall clock. This verify
branch pins that test clock and advances the intentional 1 ms timeout timer, making the regression deterministic.

Control-plane value improved: `handoff_evidence_quality` and `ready_status_truth`. The selected source release adds a
live account-scoped quant witness endpoint, and this verify PR records the exact CI blocker and fix needed to keep green
promotion-to-rollout flow trustworthy.

## Governing requirements

- `docs/agents/designs/189-jangar-account-scoped-quant-witness-custody-and-route-reentry-2026-05-13.md`: account-scoped
  quant witnesses must provide route-reentry evidence without widening capital exposure.
- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`: verify stages must merge only green PRs and
  prove Argo sync, workload readiness, and service health after rollout.
- Runtime acceptance contract: selected PRs must advance failed AgentRun reduction, PR-to-rollout latency,
  ready-status truth, manual-intervention reduction, or handoff evidence quality.
- GitOps safety requirement: no direct production mutation from the local shell; promotion happens through PR merge and
  Argo reconciliation.

## PRs touched

- #6440 `feat(jangar): add account-scoped quant witness`
  - Purpose: add account-scoped quant witness evidence for Torghut routeability re-entry, including endpoint docs,
    route wiring, witness builder, and regression coverage.
  - Merge gate: non-draft, no review threads, no requested changes, CLEAN/MERGEABLE, and all visible checks green or
    intentionally skipped before merge.
  - Merge outcome: squash-merged at `2026-05-13T15:53:51Z` as
    `590379886ae32e68013204094f67660b3879c4fe`.
  - Post-merge checks: `jangar-build-push` run `25810435329` passed, and `jangar-release` run `25811085370` passed.
- #6446 `chore(jangar): promote image 59037988`
  - Purpose: promote the #6440 image through GitOps.
  - Image tag: `59037988`.
  - Jangar image digest: `sha256:d36014cfdf350b30a8c10ef4238c1e6fdd51e6e6f390b2b012d070f99560035e`.
  - Agents control-plane image digest:
    `sha256:b4e388efb61593dbb3798a2510fc76b600c08b0fd699b922e6edc9fa945a0a3d`.
  - Merge outcome: auto-merged at `2026-05-13T16:07:28Z` as
    `8caf6b7b0b7974d5f59a075ea3f44c72c1ef70a1`.
  - Rollout check: `jangar-post-deploy-verify` run `25811195082` passed.
  - CI blocker found after merge: `jangar-ci / lint-and-typecheck` run `25811174446` failed in
    `src/routes/api/torghut/trading/control-plane/quant/-account-witness.test.ts`.
- #6447 `chore(jangar): promote image 146bbce5`
  - Purpose: promote current main after a Torghut source merge advanced the branch past #6446.
  - Image tag: `146bbce5`.
  - Jangar image digest: `sha256:5a333a5d3a631ec2e16a2681b443d3a9309e080bd2216c2756e67f83be0b6157`.
  - Agents control-plane image digest:
    `sha256:e2b2a6bc2c5cf7cae253e1dd17b080ff206b1e46fe75d71a3592a039aa9a2675`.
  - Merge outcome: auto-merged at `2026-05-13T16:13:31Z` as
    `fc0aaebeddd92dcdbca933aa03426bd8eb630736`.
  - Rollout check: `jangar-post-deploy-verify` run `25811518735` passed.
  - CI blocker repeated: `jangar-ci / lint-and-typecheck` run `25811494156` failed on the same account-witness
    assertion.
- #6399 `docs(jangar): record control-plane release gate`
  - Purpose: durable handoff and repair PR for this verify run.
  - Change: records the #6440/#6446/#6447 release slice and pins the account-witness timeout regression clock so Jangar
    promotion CI can return green.

## Comments and conflicts

- #6440 had no review threads, no requested changes, and no merge conflicts when selected.
- #6446 and #6447 had no review threads or requested changes. They auto-merged after GitOps validation checks passed.
- Progress comments were kept current with `services/jangar/scripts/codex/codex-progress-comment.ts` after merge and
  rollout state changed.
- No direct production mutation was made from this shell. All production changes landed through PR merge and GitOps.

## Deployment evidence

- Argo after #6447:
  - `jangar sync=Synced health=Healthy rev=fc0aaebeddd92dcdbca933aa03426bd8eb630736`
  - `agents sync=Synced health=Healthy rev=fc0aaebeddd92dcdbca933aa03426bd8eb630736`
  - `torghut sync=Synced health=Healthy rev=fc0aaebeddd92dcdbca933aa03426bd8eb630736`
- Workloads:
  - `deployment/jangar -n jangar`: 1/1 ready, image
    `registry.ide-newton.ts.net/lab/jangar:146bbce5@sha256:5a333a5d3a631ec2e16a2681b443d3a9309e080bd2216c2756e67f83be0b6157`.
  - `deployment/agents -n agents`: 1/1 ready, image
    `registry.ide-newton.ts.net/lab/jangar-control-plane:146bbce5@sha256:e2b2a6bc2c5cf7cae253e1dd17b080ff206b1e46fe75d71a3592a039aa9a2675`.
  - `deployment/agents-controllers -n agents`: 2/2 ready, image
    `registry.ide-newton.ts.net/lab/jangar:146bbce5@sha256:5a333a5d3a631ec2e16a2681b443d3a9309e080bd2216c2756e67f83be0b6157`.
- Service health:
  - `deployment/jangar`, `deployment/agents`, and `deployment/agents-controllers` rollout status succeeded.
  - `http://jangar.jangar.svc.cluster.local/health`: HTTP 200, `status=ok`.
  - `http://jangar.jangar.svc.cluster.local/ready`: HTTP 200, `status=ok`, `torghut_consumer_evidence=current`,
    `evidence_pressure_ledger=jangar.evidence-pressure-ledger.v1`.
  - `http://agents.agents.svc.cluster.local/ready`: HTTP 200, `status=ok`, `torghut_consumer_evidence=current`.
  - Account witness endpoint:
    `GET /api/torghut/trading/control-plane/quant/account-witness?account=paper&window=15m&timeout_ms=2000`
    returned `ok=true`, `schema_version=jangar.quant-account-witness.v1`, `aggregate_latest_store=current`,
    `account_latest_store=empty`, `pipeline_health=missing`, and `max_notional=0`.
- Events: recent warning events were readiness probes during replacement of the old Jangar pod. Current Jangar and
  Agents deployments are rolled out and ready.

## Validation

- Reproduced CI failure:
  - `bun run --cwd services/jangar test -- src/routes/api/torghut/trading/control-plane/quant/-account-witness.test.ts -t "keeps aggregate latest-store timeout advisory"`
  - Failed before the fix with `expected 'stale' to be 'current'`.
- Passing local checks after the fix:
  - `bun run --cwd services/jangar test -- src/routes/api/torghut/trading/control-plane/quant/-account-witness.test.ts -t "keeps aggregate latest-store timeout advisory"`
  - `bun run --cwd services/jangar test -- src/routes/api/torghut/trading/control-plane/quant/-account-witness.test.ts`
  - `bunx oxfmt --check services/jangar packages/scripts/src/jangar argocd/applications/jangar`
  - `bun run --cwd services/jangar lint:oxlint`
  - `bun run --cwd services/jangar lint:oxlint:type`
  - `bash -lc 'for name in $(env | cut -d= -f1 | grep -E "^(CODEX_|SWARM_|OWNER_CHANNEL$|PR_NUMBER_PATH$|PR_URL_PATH$|NATS_|JANGAR_|AGENT_PROVIDER|AGENT_RUN)"); do unset "$name"; done; cd services/jangar && bun run test && bunx tsc --noEmit --project tsconfig.paths.json && bun run docs:inventory:check && bun run check:module-sizes'`
  - `bun run --cwd services/jangar build`
- Note: the unstripped full test command fails locally because this AgentRun exports release/deployer environment
  variables that change `scripts/codex/__tests__/codex-implement.test.ts` lane resolution. The clean-env rerun matches
  CI behavior and passed.

## Metrics and value gates

- `ready_status_truth`: improved. `/ready` exposes account-witness and evidence-pressure state directly, including the
  live degraded trust reason from pre-existing Torghut quant stage freezes.
- `handoff_evidence_quality`: improved. The handoff now names the exact failed promotion check, failing assertion,
  deterministic test fix, local validation commands, rollout revision, image digests, and rollback path.
- `manual_intervention_count`: zero direct production mutations.
- `pr_to_rollout_latency`: #6440 source merge to #6446 post-deploy verifier completion was 17m32s. #6447 post-deploy
  verifier completed 3m33s after the #6447 promotion merge.
- `failed_agentrun_rate`: expected improvement is fewer verify-stage reruns caused by ambiguous account-scoped quant
  evidence and by the now-deterministic account-witness timeout regression.

## Risks and rollback path

- Residual risk: #6446 and #6447 promotion PRs are already merged and deployed healthy, but their historical
  `jangar-ci / lint-and-typecheck` runs are red until this verify fix lands and the next Jangar promotion proves the
  corrected regression on GitHub.
- Runtime risk is bounded by zero-notional witness behavior. The live endpoint reports `max_notional=0` and does not
  clear routeability when account evidence is empty or stale.
- Pre-existing runtime risk remains: `/ready` reports `execution_trust=degraded` due Torghut quant stage freezes, while
  Jangar/Agents service readiness and GitOps rollout are healthy.
- Roll back through GitOps by reverting #6447 to restore image `59037988`, or by reverting #6446 to restore the prior
  Jangar image. Revert #6440 only if the account-scoped witness implementation itself causes runtime regression.
- Do not patch live Deployments directly except under an explicit emergency procedure; Argo should remain the source of
  truth.

## Next action

Merge #6399 after green checks, then verify the next Jangar image promotion and rollout so the promotion check history is
green again with the deterministic account-witness regression.
