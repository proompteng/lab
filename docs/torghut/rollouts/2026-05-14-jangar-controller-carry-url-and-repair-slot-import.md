# Torghut Jangar Controller Carry URL And Repair-Slot Import

Date: 2026-05-14

Governing design:

- `docs/torghut/design-system/v6/211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md`
- Companion: `docs/agents/designs/205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md`

## Runtime Requirement

`GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` is the revenue-blocker source of truth. The
selected live queue item remains `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, value gate
`routeable_candidate_count`, and capital rule `zero_notional_repair_only`.

## Evidence

Before change, live Torghut reported:

- `business_state=repair_only`
- `revenue_ready=false`
- top `repair_queue` item `repair_alpha_readiness`
- selected value gate `routeable_candidate_count`
- `accepted_routeable_candidate_count=0`
- `zero_notional_or_stale_evidence_rate=1.0`
- `max_notional=0`
- no-delta denial included `jangar_verification_carry_unavailable`

During implementation, live Torghut had progressed to emitting `jangar_controller_ingestion_carry`, but it still
reported `carry_state=unavailable` with `jangar_control_plane_status_url_missing`. Live Jangar control-plane status at
`http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents` exposed:

- `controller_ingestion_settlement.decision=hold`
- `controller_ingestion_settlement.repair_slot_escrow_ref` present
- `repair_slot_escrow.status=block`
- controller carry still zero-notional; no live or paper widening was authorized

Follow-up evidence showed the full Jangar status route could exceed Torghut's 2 second import timeout on a cold
request, which turned current Jangar carry into `jangar_status_fetch_failed`. The low-latency Jangar `/ready` route
already carried verify-foreclosure and repair-slot evidence, but not `controller_ingestion_settlement`.

After local changes, pre-deploy live Torghut business evidence is intentionally unchanged until GitOps rolls the new
manifest and image:

- `business_state=repair_only`
- `revenue_ready=false`
- top `repair_queue` item `repair_alpha_readiness`
- selected value gate `routeable_candidate_count`
- `accepted_routeable_candidate_count=0`
- `zero_notional_or_stale_evidence_rate=1.0`
- `max_notional=0`

## Change

- The live Torghut Knative service now sets `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL` to the cluster-local Jangar
  `/ready` route instead of the slower full control-plane status route.
- Jangar `/ready` now emits `controller_ingestion_settlement` alongside `verify_trust_foreclosure_board` and
  `repair_slot_escrow`, using hot-path proof fields that explicitly say full source-serving and database proof remain
  available from `/api/agents/control-plane/status`.
- `JangarDependencyQuorumStatus` now preserves `repair_slot_escrow`, `stage_debt_repair_admission`, and
  `foreclosure_carry_rollout_witness`.
- `JangarDependencyQuorumStatus` also preserves top-level `controller_ingestion_settlement` from legacy or `/ready`
  payloads that do not include a nested `dependency_quorum`.
- Revenue repair, health, and consumer evidence pass those carry fields into
  `torghut.jangar-controller-ingestion-carry.v1`.
- Held or blocked Jangar controller-ingestion settlements with current board or repair-slot evidence classify as
  `lagging`, not as generic missing carry.
- No selected ticket can bypass `repairable` carry, and every selected or held ticket remains `max_notional=0`.

## Validation

- `uv sync --frozen --extra dev`
- `uv run --frozen pytest tests/test_live_config_manifest_contract.py tests/test_jangar_controller_ingestion_carry.py tests/test_hypotheses.py tests/test_trading_api.py tests/test_no_delta_repair_reentry_auction.py tests/test_build_revenue_repair_digest.py`
- `uv run --frozen ruff check app/main.py app/trading/hypotheses.py app/trading/jangar_controller_ingestion_carry.py tests/test_hypotheses.py tests/test_jangar_controller_ingestion_carry.py tests/test_live_config_manifest_contract.py tests/test_trading_api.py`
- `uv run --frozen ruff format --check app/main.py app/trading/hypotheses.py app/trading/jangar_controller_ingestion_carry.py tests/test_hypotheses.py tests/test_jangar_controller_ingestion_carry.py tests/test_live_config_manifest_contract.py tests/test_trading_api.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- `kubectl kustomize argocd/applications/torghut`
- `bun run lint:argocd`

## Risk And Rollback

Risk is limited to Torghut observing Jangar `/ready` for revenue-repair carry. This does not enable live
submission, paper widening, or nonzero notional. The rollback is to remove `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`
from `argocd/applications/torghut/knative-service.yaml` and stop emitting the additional repair-slot carry fields;
Torghut will return to the existing unavailable-carry denial while keeping `max_notional=0`.

## Owner Status

The revenue metric targeted is `routeable_candidate_count`. This PR does not claim a routeable-count increase before
deployment; it removes the smallest observed blocker preventing the no-delta auction from consuming Jangar carry:
`jangar_control_plane_status_url_missing`, then preserves the repair-slot evidence needed to name the next blocker.
