# Jangar Alpha Closure Ingestion Handoff (2026-05-14)

Status: Accepted for engineer and deployer handoff
Owner: Victor Chen, Jangar Engineering Architecture
Related designs:

- `docs/agents/designs/197-jangar-compact-alpha-closure-ingestion-and-stage-credit-repair-gate-2026-05-14.md`
- `docs/torghut/design-system/v6/202-torghut-compact-alpha-closure-export-and-no-delta-lease-2026-05-14.md`

## Decision

Export a compact Torghut alpha closure passport through `/trading/consumer-evidence`, then have Jangar ingest it and
gate `dispatch_repair` on freshness, zero-notional safety, source-serving proof, and no-delta budget state.

## Evidence

- Argo `agents`, `jangar`, and `torghut` were `Synced/Healthy` at
  `29f0d1c9fd417fc65666896b6b5433be668c78a5`.
- `agents=1/1`, `agents-controllers=2/2`, and `jangar=1/1`.
- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`; execution trust was healthy.
- Jangar control-plane status kept material action blocked: only `serve_readonly` and `torghut_observe` were allowed;
  `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary` were held.
- Stage credit ledger `stage-credit-ledger:agents:333cd83121fa0e4b` held normal dispatch and repair due to source
  rollout truth, route stability, controller witness split, Torghut repair state, and insufficient credit.
- Source-serving contract verdict was blocked by source CI retention missing, source-serving build mismatch, and
  manifest image digest missing.
- Torghut `/db-check` was schema-current at `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- Torghut `/readyz` was degraded for correct capital-safety reasons: `simple_submit_disabled`, zero promotion-eligible
  hypotheses, and feature evidence blockers.
- Torghut `/trading/revenue-repair` included `alpha_repair_closure_board.status=selected`, market
  `alpha-closure-settlement-market:2b8cebb98cc14f7b9a7dd031`, selected hypothesis `H-MICRO-01`, required receipt
  `torghut.alpha-closure-settlement-receipt.v1`, and no-delta budget `consumed`.
- Jangar consumer evidence did not expose `alpha_repair_closure_board_ref` or `alpha_evidence_foundry_ref`.

## Engineer Acceptance Gates

- Torghut emits an additive `alpha_closure_passport` on `/trading/consumer-evidence`.
- The passport includes board id, market id, selected hypothesis, selected value gate, required receipt, active dedupe
  key, no-delta state, source revision, serving image digest, max notional, validation commands, and rollback target.
- Jangar parses the passport in observe mode and validates schema, freshness, selected gate, notional, capital rule,
  required receipt, and no-delta state.
- Jangar emits `alpha_closure_repair_gate` in control-plane status.
- Current live evidence produces hold or deny because the no-delta budget is consumed.
- Tests cover current passport, missing passport, stale passport, consumed no-delta, nonzero notional, wrong gate,
  source-serving mismatch, and paper/live action denial.

## Deployer Acceptance Gates

- Argo `agents`, `jangar`, and `torghut` are `Synced/Healthy`.
- `kubectl rollout status -n agents deployment/agents` and
  `kubectl rollout status -n agents deployment/agents-controllers` pass.
- `GET http://agents.agents.svc.cluster.local/ready` returns `status=ok`.
- Jangar control-plane status includes the alpha closure repair gate.
- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` includes the full alpha closure board.
- `GET http://torghut.torghut.svc.cluster.local/trading/consumer-evidence` includes the compact passport.
- Torghut remains `max_notional=0` and live submission remains disabled.
- `/readyz` may remain HTTP 503 while the live submit gate and proof floor are intentionally closed.

## Rollback

- Disable compact passport emission or mark it observe-only.
- Set Jangar alpha closure repair gate mode to `observe`.
- Keep existing ready truth, stage credit, material reentry, executable alpha repair receipts, and full revenue-repair
  board active.
- Preserve no-delta receipts for audit.
- Do not delete AgentRuns, jobs, database rows, or trading evidence.

## Next Milestone

Implement the compact passport and Jangar parser first. The exact next action is a production PR that adds
`alpha_closure_passport` to Torghut consumer evidence and exposes a Jangar `alpha_closure_repair_gate` in observe mode.
The control-plane metric improved is `failed_agentrun_rate`; the smallest blocker is missing compact closure passport
visibility plus consumed no-delta debt for the current `H-MICRO-01` closure.
