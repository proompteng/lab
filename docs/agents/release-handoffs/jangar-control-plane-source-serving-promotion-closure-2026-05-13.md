# Jangar Control Plane Source-Serving Promotion Closure Handoff (2026-05-13)

## Design And Requirement Provenance

- Governing design:
  `docs/agents/designs/192-jangar-source-to-serving-promotion-closure-and-repair-value-accounting-2026-05-13.md`
- Companion Torghut design:
  `docs/torghut/design-system/v6/197-torghut-serving-promotion-closure-and-no-delta-repair-value-2026-05-13.md`
- Business metric: reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout time for the Jangar control
  plane.
- Value gates: `failed_agentrun_rate`, `pr_to_rollout_latency`, `ready_status_truth`,
  `manual_intervention_count`, `handoff_evidence_quality`.

## Evidence Summary

- `agents` and `jangar` were `Synced/Healthy` at revision `6f1aa11d5a128d7cb6e42aa4aeb67660a380d57e`;
  `torghut` was `Synced/Healthy` at revision `d4703334a83b3fa8933486f56491626580eab8b6`.
- Agents and Jangar workloads were ready. Current Torghut live and sim revisions were ready after normal startup
  probe noise.
- AgentRuns in the last 24 hours summarized to `97` Succeeded, `10` Failed, and `5` Running. Jangar control-plane
  AgentRuns in the same window summarized to `47` Succeeded, `3` Failed, and `2` Running.
- Jangar status held material action on `source_ci_retention_receipt_missing`, `source_serving_build_mismatch`,
  `manifest_image_digest_missing`, `62` stale-foreclosed projections, one contradictory projection, and one missing
  receipt.
- Torghut `/trading/revenue-repair` was repair-only with `32` raw repair bids, `5` selected compacted lots, `3`
  dispatchable lots, routeable count `0`, and max notional `0`.

## Engineer Handoff

Implement `promotion_closure_ledger` as a pure Jangar reducer before changing scheduling behavior.

Acceptance gates:

- source CI retention missing, manifest digest missing, and serving build mismatch each produce one closure lot;
- selected Torghut repair lots carry one expected output receipt and max notional `0`;
- stale projection counts are represented without mutating database rows;
- service readiness remains available while material launch is held;
- tests cover closure states and no-delta repair accounting.

## Deployer Handoff

Use promotion closure, not Argo alone, for green PR-to-healthy claims once the reducer lands.

Acceptance gates:

- Argo `agents`, `jangar`, `torghut`, and `torghut-options` synced and healthy;
- Jangar `/ready` and control-plane status reachable;
- status includes `promotion_closure_ledger`;
- Torghut `/db-check` schema current;
- Torghut max notional remains `0`;
- handoff names the closed receipt or the smallest remaining closure blocker.

## Rollback

Keep rollback configuration-first: disable closure-ledger consumption, keep the payload visible if stable, fall back to
source-serving verdicts and repair-bid admission, and do not delete AgentRuns, jobs, receipts, or database rows.
