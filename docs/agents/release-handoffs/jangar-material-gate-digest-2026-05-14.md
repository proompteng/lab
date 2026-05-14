# Jangar Material Gate Digest Handoff (2026-05-14)

Status: Accepted for engineer and deployer handoff
Owner: Victor Chen, Jangar Engineering Architecture
Related designs:

- `docs/agents/designs/198-jangar-material-gate-digest-and-alpha-closure-carry-2026-05-14.md`
- `docs/torghut/design-system/v6/203-torghut-alpha-closure-dividend-slo-and-consumer-evidence-carry-2026-05-14.md`

## Decision

Build a small Jangar material gate digest that carries Torghut alpha closure no-delta custody from consumer evidence
into `/ready`, then use it to hold duplicate zero-notional repair launch keys before another runner pod starts.

## Evidence

- Argo `agents`, `jangar`, and `torghut` were `Synced/Healthy` at
  `60ea7ce8935a77676696b415bcd16fddbedd0575`.
- Workloads were available: `agents=1/1`, `agents-controllers=2/2`, `jangar=1/1`, `torghut-00377=2/2`, and
  `torghut-sim-00475=2/2`.
- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`, but business state remained
  `repair_only`, revenue was not ready, and the top queue item was `repair_alpha_readiness`.
- Jangar repair-bid admission was `observe` and `block`, yet it still emitted a launch-allowed promotion-custody ticket
  for dedupe key `PA3SX7FYNUTF:15m:promotion_custody`.
- `GET /api/agents/control-plane/status?namespace=agents` timed out at 10 seconds in this run, so full status should
  not be the synchronous launch hot path.
- Torghut `/db-check` was schema-current at `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- Torghut `/readyz` was HTTP 503 for correct capital-safety reasons: live submit disabled and zero promotion-eligible
  hypotheses.
- Torghut `/trading/consumer-evidence` included compact `torghut.alpha-repair-closure-board-ref.v1` with selected
  hypothesis `H-MICRO-01`, no-delta budget `consumed`, no-delta debt count `1`, and `max_notional=0`.
- Jangar `/ready` did not yet carry that compact board ref in its Torghut projection.

## Engineer Acceptance Gates

- Jangar emits additive `material_gate_digest` on `/ready`.
- The digest carries Torghut board id, settlement market id, selected hypothesis, selected value gate, active dedupe
  key, no-delta state, no-delta debt count, max notional, and capital rule.
- Current live evidence produces `dispatch_repair=hold` or `deny` because no-delta budget is consumed.
- Full status route timeout records `full_status_unavailable` without failing serving readiness.
- Tests cover current, missing, stale, wrong-gate, nonzero-notional, consumed no-delta, and full-status-timeout cases.

## Deployer Acceptance Gates

- Argo `agents`, `jangar`, and `torghut` are `Synced/Healthy`.
- `kubectl rollout status -n agents deployment/agents` passes.
- `kubectl rollout status -n agents deployment/agents-controllers` passes.
- `kubectl rollout status -n jangar deployment/jangar` passes.
- `GET http://agents.agents.svc.cluster.local/ready` includes `material_gate_digest`.
- `GET http://torghut.torghut.svc.cluster.local/trading/consumer-evidence` includes the compact closure board ref and
  dividend SLO.
- Torghut remains `max_notional=0`; live submission remains disabled.
- `/readyz` may remain HTTP 503 while proof floor and live submit stay intentionally closed.

## Rollback

- Disable the material gate digest or mark it observe-only.
- Keep existing ready truth, stage credit, repair-bid admission, and Torghut consumer evidence reducers active.
- Hold material repair dispatch when the digest is absent.
- Keep Torghut capital zero-notional and live submission disabled.
- Do not delete AgentRuns, jobs, database rows, closure boards, or no-delta receipts.

## Next Milestone

Implement the digest and dividend SLO in observe mode first. The control-plane metric improved is
`failed_agentrun_rate`; the smallest revenue blocker remains `routeable_candidate_count=0` until H-MICRO-01 feature
replay produces a terminal settlement receipt that retires the current feature evidence blockers.
