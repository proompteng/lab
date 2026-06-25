"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from ...bootstrap import evaluate_scheduler_status as _evaluate_scheduler_status
from typing import Any


from .shared_context import (
    BUILD_IMAGE_DIGEST,
    BUILD_VERSION,
    JangarDependencyQuorumStatus,
    Mapping,
    SessionLocal,
    guard_live_submission_gate_for_readiness as _guard_live_submission_gate_for_readiness,
    readiness_dependency_degradation_reason_codes as _readiness_dependency_degradation_reason_codes,
    readiness_dependency_snapshot as _readiness_dependency_snapshot,
    strip_promotion_authority_claims_for_readiness as _strip_promotion_authority_claims_for_readiness,
    active_simulation_runtime_context,
    build_alpha_closure_dividend_slo,
    build_revenue_repair_digest,
    cast,
    compact_alpha_evidence_foundry,
    compact_alpha_readiness_settlement_conveyor,
    compact_alpha_repair_closure_board,
    compact_alpha_repair_dividend_ledger,
    compact_executable_alpha_settlement_slots,
    compact_jangar_controller_ingestion_carry,
    compact_no_delta_repair_reentry_auction,
    datetime,
    load_quant_evidence_status,
    main_runtime_value,
    settings,
    timezone,
)
from . import status_dependencies as _status_dependencies
from .universe_dependency import (
    evaluate_universe_dependency as evaluate_universe_dependency,
)
from ..trading_scheduler_state import get_trading_scheduler

_PROOF_LANE_DEPENDENCY_KEYS = frozenset(
    {
        "empirical_jobs",
        "live_submission_gate",
        "profitability_proof_floor",
    }
)


def evaluate_trading_health_payload(
    *,
    include_database_contract: bool = False,
    allow_stale_dependency_cache: bool = False,
) -> tuple[dict[str, object], int]:
    """Build shared trading health payload and status code."""

    scheduler = get_trading_scheduler()
    scheduler_ok, scheduler_payload = _evaluate_scheduler_status(scheduler)

    now = datetime.now(timezone.utc)
    with SessionLocal() as session:
        dependencies, checked_at, cache_used = _readiness_dependency_snapshot(
            session,
            include_database_contract=include_database_contract,
            allow_stale_dependency_cache=allow_stale_dependency_cache,
        )
    dependencies = dict(dependencies)
    dependencies["universe"] = evaluate_universe_dependency(scheduler)
    cache_age_seconds = (now - checked_at).total_seconds() if checked_at else 0.0
    cache_age_seconds = 0.0 if cache_age_seconds < 0 else round(cache_age_seconds, 3)
    cache_stale = (
        cache_used
        and cache_age_seconds > settings.trading_readiness_dependency_cache_ttl_seconds
    )
    dependencies["readiness_cache"] = {
        "checked_at": checked_at.isoformat(),
        "cache_ttl_seconds": settings.trading_readiness_dependency_cache_ttl_seconds,
        "cache_stale_tolerance_seconds": settings.trading_readiness_dependency_cache_stale_tolerance_seconds,
        "cache_used": cache_used,
        "cache_age_seconds": cache_age_seconds,
        "cache_stale": cache_stale,
    }

    alpha_readiness: dict[str, object]
    tca_summary: dict[str, object] = {}
    market_context_status = scheduler.market_context_status()
    _hypothesis_payload: Mapping[str, object] = {}
    _dependency_quorum = JangarDependencyQuorumStatus(
        decision="unknown",
        reasons=["alpha_readiness_not_evaluated"],
        message="alpha readiness not evaluated",
    )
    try:
        with SessionLocal() as session:
            tca_summary = _status_dependencies.load_tca_summary(
                session,
                scheduler=scheduler,
            )
        _hypothesis_payload, hypothesis_summary, _dependency_quorum = (
            _status_dependencies.build_hypothesis_runtime_payload(
                scheduler,
                tca_summary=tca_summary,
                market_context_status=market_context_status,
            )
        )
        alpha_readiness = {
            "hypotheses_total": hypothesis_summary.get("hypotheses_total", 0),
            "state_totals": hypothesis_summary.get("state_totals", {}),
            "promotion_eligible_total": hypothesis_summary.get(
                "promotion_eligible_total", 0
            ),
            "rollback_required_total": hypothesis_summary.get(
                "rollback_required_total", 0
            ),
            "dependency_quorum": hypothesis_summary.get("dependency_quorum", {}),
        }
    except Exception as exc:  # pragma: no cover - additive status surface only
        alpha_readiness = {
            "hypotheses_total": 0,
            "state_totals": {},
            "promotion_eligible_total": 0,
            "rollback_required_total": 0,
            "dependency_quorum": {
                "decision": "unknown",
                "reasons": ["alpha_readiness_unavailable"],
                "message": str(exc),
            },
        }
        _dependency_quorum = JangarDependencyQuorumStatus(
            decision="unknown",
            reasons=["alpha_readiness_unavailable"],
            message=str(exc),
        )
        hypothesis_summary = {}

    llm_status = scheduler.llm_status()
    dspy_runtime = (
        cast(dict[str, object], llm_status.get("dspy_runtime"))
        if isinstance(llm_status.get("dspy_runtime"), dict)
        else {}
    )
    empirical_jobs = _status_dependencies.empirical_jobs_status()
    quant_evidence = load_quant_evidence_status(
        account_label=settings.trading_account_label,
    )
    with SessionLocal() as session:
        live_submission_gate = (
            _status_dependencies.build_api_live_submission_gate_payload(
                scheduler.state,
                session=session,
                hypothesis_summary=_hypothesis_payload,
                empirical_jobs_status=empirical_jobs,
                dspy_runtime_status=dspy_runtime,
                quant_health_status=quant_evidence,
            )
        )
    proof_floor = _status_dependencies.build_profitability_proof_floor_payload(
        state=scheduler.state,
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        live_submission_gate=live_submission_gate,
        hypothesis_payload=_hypothesis_payload,
        empirical_jobs_status=empirical_jobs,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        tca_summary=tca_summary,
    )
    renewal_bond_profit_escrow = (
        _status_dependencies.build_renewal_bond_profit_escrow_payload(
            state=scheduler.state,
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            live_submission_gate=live_submission_gate,
            proof_floor=proof_floor,
            hypothesis_payload=_hypothesis_payload,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
        )
    )
    route_reacquisition_board = (
        _status_dependencies.build_route_reacquisition_board_payload(
            proof_floor=proof_floor,
            active_revision=main_runtime_value("BUILD_COMMIT"),
        )
    )
    profit_signal_quorum = _status_dependencies.build_profit_signal_quorum_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        dependency_quorum=_dependency_quorum.as_payload(),
        hypothesis_payload=_hypothesis_payload,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        proof_floor=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
    )
    with SessionLocal() as session:
        options_catalog_freshness = (
            _status_dependencies.load_options_catalog_freshness_summary(
                session,
                route_symbols=_status_dependencies.route_claim_symbols(
                    profit_signal_quorum
                ),
            )
        )
    capital_replay_projection = (
        _status_dependencies.build_capital_replay_projection_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            live_submission_gate=live_submission_gate,
            proof_floor=proof_floor,
            route_reacquisition_board=route_reacquisition_board,
            empirical_jobs_status=empirical_jobs,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
        )
    )
    quality_adjusted_profit_frontier = (
        _status_dependencies.build_quality_adjusted_profit_frontier_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            live_submission_gate=live_submission_gate,
            proof_floor=proof_floor,
            route_reacquisition_board=route_reacquisition_board,
            hypothesis_payload=_hypothesis_payload,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            active_simulation_context=active_simulation_runtime_context(),
        )
    )
    consumer_evidence_receipt, route_proven_profit_receipt = (
        _status_dependencies.build_consumer_evidence_receipt_projection(
            forecast_service_status=_status_dependencies.forecast_service_status(
                empirical_jobs
            ),
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            live_submission_gate=live_submission_gate,
            serving_revision=_status_dependencies.active_runtime_revision()
            or main_runtime_value("BUILD_COMMIT"),
        )
    )
    capital_reentry_cohort_ledger = (
        _status_dependencies.build_capital_reentry_cohort_ledger_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            consumer_evidence_receipt=consumer_evidence_receipt,
            proof_floor=proof_floor,
            route_reacquisition_board=route_reacquisition_board,
        )
    )
    profit_repair_settlement_ledger = (
        _status_dependencies.build_profit_repair_settlement_ledger_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            consumer_evidence_receipt=consumer_evidence_receipt,
            proof_floor=proof_floor,
            capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
            quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
            route_reacquisition_board=route_reacquisition_board,
            live_submission_gate=live_submission_gate,
            quant_evidence=quant_evidence,
        )
    )
    routeability_repair_acceptance_ledger = (
        _status_dependencies.build_routeability_repair_acceptance_ledger_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            consumer_evidence_receipt=consumer_evidence_receipt,
            proof_floor=proof_floor,
            capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
            quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
            profit_repair_settlement_ledger=profit_repair_settlement_ledger,
            route_reacquisition_board=route_reacquisition_board,
            live_submission_gate=live_submission_gate,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
        )
    )
    profit_freshness_frontier = (
        _status_dependencies.build_profit_freshness_frontier_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            proof_floor=proof_floor,
            routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
            quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
            route_reacquisition_board=route_reacquisition_board,
            live_submission_gate=live_submission_gate,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            empirical_jobs_status=empirical_jobs,
            hypothesis_payload=_hypothesis_payload,
        )
    )
    build_payload = {
        "version": BUILD_VERSION,
        "commit": main_runtime_value("BUILD_COMMIT"),
        "image_digest": BUILD_IMAGE_DIGEST,
        "active_revision": _status_dependencies.active_runtime_revision()
        or main_runtime_value("BUILD_COMMIT"),
    }
    clickhouse_ta_status = _status_dependencies.load_clickhouse_ta_status(scheduler)
    evidence_clock_arbiter, routeable_profit_candidate_exchange = (
        _status_dependencies.build_evidence_clock_payloads(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            hypothesis_payload=_hypothesis_payload,
            quant_evidence=quant_evidence,
            market_context_status=market_context_status,
            tca_summary=tca_summary,
            empirical_jobs_status=empirical_jobs,
            proof_floor=proof_floor,
            routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
            profit_signal_quorum=profit_signal_quorum,
            live_submission_gate=live_submission_gate,
            build=build_payload,
            clickhouse_ta_status=clickhouse_ta_status,
        )
    )
    clock_settlement_receipt = _status_dependencies.build_clock_settlement_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        source_commit=main_runtime_value("BUILD_COMMIT"),
        build=build_payload,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        profit_signal_quorum=profit_signal_quorum,
        rollout_status=_status_dependencies.build_route_image_proof_summary(
            build=build_payload,
            dependency_quorum=_dependency_quorum.as_payload(),
        ),
    )
    route_evidence_clearinghouse_packet = (
        _status_dependencies.build_route_evidence_clearinghouse_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            source_commit=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            build=build_payload,
            proof_floor=proof_floor,
            profit_signal_quorum=profit_signal_quorum,
            profit_repair_settlement_ledger=profit_repair_settlement_ledger,
            route_reacquisition_board=route_reacquisition_board,
            routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
            live_submission_gate=live_submission_gate,
            tca_summary=tca_summary,
            options_catalog_freshness=options_catalog_freshness,
        )
    )
    repair_bid_settlement_ledger = (
        _status_dependencies.build_repair_bid_settlement_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            source_commit=main_runtime_value("BUILD_COMMIT"),
            dependency_quorum=_dependency_quorum.as_payload(),
            build=build_payload,
            route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
            routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
            quant_evidence=quant_evidence,
            profit_freshness_frontier=profit_freshness_frontier,
        )
    )
    route_warrant_exchange = _status_dependencies.build_route_warrant_exchange_payload(
        torghut_revision=main_runtime_value("BUILD_COMMIT"),
        source_commit=main_runtime_value("BUILD_COMMIT"),
        build=build_payload,
        consumer_evidence_receipt=consumer_evidence_receipt,
        evidence_clock_arbiter=evidence_clock_arbiter,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        profit_freshness_frontier=profit_freshness_frontier,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
    )
    source_serving_repair_receipt_ledger = (
        _status_dependencies.build_source_serving_repair_receipt_payload(
            source_commit=main_runtime_value("BUILD_COMMIT"),
            build=build_payload,
            consumer_evidence_receipt=consumer_evidence_receipt,
            route_evidence_clearinghouse_packet=route_evidence_clearinghouse_packet,
            repair_bid_settlement_ledger=repair_bid_settlement_ledger,
            route_warrant_exchange=route_warrant_exchange,
        )
    )
    freshness_carry_ledger = _status_dependencies.build_freshness_carry_ledger_payload(
        source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
        route_warrant_exchange=route_warrant_exchange,
        clickhouse_ta_status=clickhouse_ta_status,
        tca_summary=tca_summary,
        empirical_jobs_status=empirical_jobs,
        market_context_status=market_context_status,
        quant_evidence=quant_evidence,
        live_submission_gate=live_submission_gate,
    )
    repair_receipt_frontier = (
        _status_dependencies.build_repair_receipt_frontier_payload(
            torghut_revision=main_runtime_value("BUILD_COMMIT"),
            source_commit=main_runtime_value("BUILD_COMMIT"),
            source_serving_repair_receipt_ledger=source_serving_repair_receipt_ledger,
            freshness_carry_ledger=freshness_carry_ledger,
            repair_bid_settlement_ledger=repair_bid_settlement_ledger,
            profit_freshness_frontier=profit_freshness_frontier,
            route_warrant_exchange=route_warrant_exchange,
            live_submission_gate=live_submission_gate,
            proof_floor=proof_floor,
        )
    )
    repair_outcome_dividend_ledger = (
        _status_dependencies.build_repair_outcome_dividend_ledger_payload(
            repair_bid_settlement_ledger=repair_bid_settlement_ledger,
            repair_receipt_frontier=repair_receipt_frontier,
            freshness_carry_ledger=freshness_carry_ledger,
            route_warrant_exchange=route_warrant_exchange,
            live_submission_gate=live_submission_gate,
        )
    )
    live_mode = settings.trading_mode == "live"
    empirical_jobs_required = (
        live_mode and settings.trading_empirical_jobs_health_required
    )
    dependencies["empirical_jobs"] = {
        "ok": bool(empirical_jobs.get("ready")) if empirical_jobs_required else True,
        "detail": (
            str(empirical_jobs.get("status") or "unknown")
            if live_mode
            else "not_required_in_non_live_mode"
        ),
        "authority": empirical_jobs.get("authority"),
        "required": empirical_jobs_required,
    }
    dependencies["dspy_runtime"] = {
        "ok": bool(dspy_runtime.get("live_ready", False))
        if str(dspy_runtime.get("mode") or "").strip().lower() == "active"
        else True,
        "detail": (
            "ready"
            if bool(dspy_runtime.get("live_ready", False))
            else ", ".join(
                [
                    str(item).strip()
                    for item in cast(
                        list[object], dspy_runtime.get("readiness_reasons") or []
                    )
                    if str(item).strip()
                ]
            )
            or "not_ready"
        ),
        "artifact_hash": dspy_runtime.get("artifact_hash"),
    }
    dependencies["live_submission_gate"] = {
        "ok": bool(live_submission_gate.get("allowed", False)),
        "detail": str(live_submission_gate.get("reason") or "unknown"),
        "capital_stage": live_submission_gate.get("capital_stage"),
    }
    dependencies["profitability_proof_floor"] = {
        "ok": (
            str(proof_floor.get("route_state") or "") != "repair_only"
            if live_mode
            else True
        ),
        "detail": str(proof_floor.get("route_state") or "unknown"),
        "capital_state": proof_floor.get("capital_state"),
        "required": live_mode,
    }
    dependencies["quant_evidence"] = {
        "ok": (
            bool(quant_evidence.get("ok", True))
            if live_mode and bool(quant_evidence.get("required", False))
            else True
        ),
        "detail": (
            str(quant_evidence.get("reason") or "unknown")
            if live_mode
            else "not_required_in_non_live_mode"
        ),
        "required": bool(quant_evidence.get("required", False)),
        "window": quant_evidence.get("window"),
    }
    health_sections = split_runtime_and_proof_lane_dependencies(
        dependencies,
        scheduler_ok=scheduler_ok,
    )
    readiness_dependency_reasons = _readiness_dependency_degradation_reason_codes(
        runtime_dependencies_for_health_surface(dependencies),
        scheduler_ok=scheduler_ok,
    )
    live_submission_gate_for_readiness = _guard_live_submission_gate_for_readiness(
        live_submission_gate,
        readiness_dependency_reasons=readiness_dependency_reasons,
    )
    if bool(
        live_submission_gate_for_readiness.get("readiness_dependency_guard_active")
    ):
        dependencies["live_submission_gate"] = {
            "ok": False,
            "detail": str(
                live_submission_gate_for_readiness.get("reason")
                or "readiness_dependency_degraded"
            ),
            "capital_stage": live_submission_gate_for_readiness.get("capital_stage"),
            "readiness_dependency_guard_active": True,
            "readiness_dependency_guard_reasons": readiness_dependency_reasons,
        }
    revenue_repair_digest = build_revenue_repair_digest(
        readyz_payload={
            "status": (
                "degraded"
                if live_submission_gate_for_readiness.get("allowed") is not True
                else "ok"
            ),
            "proof_floor": proof_floor,
            "live_submission_gate": live_submission_gate_for_readiness,
            "quant_evidence": quant_evidence,
            "dependencies": dependencies,
        },
        status_payload={
            "mode": settings.trading_mode,
            "pipeline_mode": settings.trading_pipeline_mode,
            "build": build_payload,
            "dependency_quorum": _dependency_quorum.as_payload(),
            "live_submission_gate": live_submission_gate_for_readiness,
            "proof_floor": proof_floor,
            "quant_evidence": quant_evidence,
            "routeability_repair_acceptance_ledger": routeability_repair_acceptance_ledger,
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
            "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
            "capital_replay_board": capital_replay_projection.get(
                "capital_replay_board"
            ),
            "executable_alpha_receipts": capital_replay_projection.get(
                "executable_alpha_receipts"
            ),
            "controller_ingestion_settlement": _dependency_quorum.as_payload().get(
                "controller_ingestion_settlement"
            ),
            "verify_trust_foreclosure_board": _dependency_quorum.as_payload().get(
                "verify_trust_foreclosure_board"
            ),
            "repair_slot_escrow": _dependency_quorum.as_payload().get(
                "repair_slot_escrow"
            ),
            "stage_debt_repair_admission": _dependency_quorum.as_payload().get(
                "stage_debt_repair_admission"
            ),
            "foreclosure_carry_rollout_witness": _dependency_quorum.as_payload().get(
                "foreclosure_carry_rollout_witness"
            ),
            "source_serving_repair_receipt_ledger": source_serving_repair_receipt_ledger,
        },
        generated_at=now,
    )
    runtime_status = cast(Mapping[str, object], health_sections["runtime"])
    overall_ok = bool(runtime_status.get("ok"))
    status = "ok" if overall_ok else "degraded"
    status_code = 200 if overall_ok else 503

    response_payload = {
        "status": status,
        "runtime": health_sections["runtime"],
        "proof_lane": health_sections["proof_lane"],
        "scheduler": scheduler_payload,
        "dependencies": dependencies,
        "alpha_readiness": alpha_readiness,
        "live_submission_gate": live_submission_gate_for_readiness,
        "proof_floor": proof_floor,
        "renewal_bond_profit_escrow": renewal_bond_profit_escrow,
        "capital_replay_board": capital_replay_projection["capital_replay_board"],
        "executable_alpha_receipts": capital_replay_projection[
            "executable_alpha_receipts"
        ],
        "quality_adjusted_profit_frontier": quality_adjusted_profit_frontier,
        "torghut_consumer_evidence_receipt": consumer_evidence_receipt,
        "route_proven_profit_receipt": route_proven_profit_receipt,
        "consumer_evidence_canary": route_proven_profit_receipt.get("route_canary"),
        "capital_reentry_cohort_ledger": capital_reentry_cohort_ledger,
        "profit_repair_settlement_ledger": profit_repair_settlement_ledger,
        "routeability_repair_acceptance_ledger": routeability_repair_acceptance_ledger,
        "profit_freshness_frontier": profit_freshness_frontier,
        "profit_signal_quorum": profit_signal_quorum,
        "evidence_clock_arbiter": evidence_clock_arbiter,
        "routeable_profit_candidate_exchange": routeable_profit_candidate_exchange,
        "clock_settlement_receipt": clock_settlement_receipt,
        "route_evidence_clearinghouse_packet": route_evidence_clearinghouse_packet,
        "repair_bid_settlement_ledger": repair_bid_settlement_ledger,
        **_status_dependencies.revenue_repair_topline_fields(revenue_repair_digest),
        "route_warrant_exchange": route_warrant_exchange,
        "source_serving_repair_receipt_ledger": source_serving_repair_receipt_ledger,
        "freshness_carry_ledger": freshness_carry_ledger,
        "repair_receipt_frontier": repair_receipt_frontier,
        "repair_outcome_dividend_ledger": repair_outcome_dividend_ledger,
        "executable_alpha_settlement_slots": compact_executable_alpha_settlement_slots(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("executable_alpha_settlement_slots"),
            )
        ),
        "alpha_repair_closure_board": compact_alpha_repair_closure_board(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_repair_closure_board"),
            )
        ),
        "alpha_evidence_foundry": compact_alpha_evidence_foundry(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_evidence_foundry"),
            )
        ),
        "alpha_readiness_settlement_conveyor": compact_alpha_readiness_settlement_conveyor(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_readiness_settlement_conveyor"),
            )
        ),
        "alpha_repair_dividend_ledger": compact_alpha_repair_dividend_ledger(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("alpha_repair_dividend_ledger"),
            )
        ),
        "alpha_closure_dividend_slo": build_alpha_closure_dividend_slo(
            generated_at=datetime.now(timezone.utc),
            alpha_repair_closure_board=cast(
                Mapping[str, Any] | None,
                revenue_repair_digest.get("alpha_repair_closure_board"),
            ),
            alpha_repair_dividend_ledger=cast(
                Mapping[str, Any] | None,
                revenue_repair_digest.get("alpha_repair_dividend_ledger"),
            ),
        ),
        "jangar_controller_ingestion_carry": compact_jangar_controller_ingestion_carry(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("jangar_controller_ingestion_carry"),
            )
        ),
        "no_delta_repair_reentry_auction": compact_no_delta_repair_reentry_auction(
            cast(
                Mapping[str, Any],
                revenue_repair_digest.get("no_delta_repair_reentry_auction"),
            )
        ),
        "route_reacquisition_book": proof_floor.get("route_reacquisition_book"),
        "route_reacquisition_board": route_reacquisition_board,
        "quant_evidence": quant_evidence,
        "profit_lease_projection": live_submission_gate_for_readiness.get(
            "profit_lease_projection"
        ),
    }
    if readiness_dependency_reasons:
        response_payload = cast(
            dict[str, object],
            _strip_promotion_authority_claims_for_readiness(response_payload),
        )

    return response_payload, status_code


def split_runtime_and_proof_lane_dependencies(
    dependencies: Mapping[str, object],
    *,
    scheduler_ok: bool,
) -> dict[str, object]:
    runtime_dependencies = runtime_dependencies_for_health_surface(dependencies)
    proof_dependencies = {
        key: value
        for key, value in dependencies.items()
        if key in _PROOF_LANE_DEPENDENCY_KEYS
    }
    runtime_ok = scheduler_ok and all(
        _dependency_ok(value) for value in runtime_dependencies.values()
    )
    proof_lane_ok = all(_dependency_ok(value) for value in proof_dependencies.values())
    return {
        "runtime": {
            "status": "ok" if runtime_ok else "degraded",
            "ok": runtime_ok,
            "scheduler_ok": scheduler_ok,
            "dependency_count": len(runtime_dependencies),
            "dependencies": dict(runtime_dependencies),
        },
        "proof_lane": {
            "status": "ok" if proof_lane_ok else "degraded",
            "ok": proof_lane_ok,
            "hot_path_authority": False,
            "required_for_runtime_health": False,
            "dependencies": dict(proof_dependencies),
        },
    }


def runtime_dependencies_for_health_surface(
    dependencies: Mapping[str, object],
) -> dict[str, object]:
    return {
        key: value
        for key, value in dependencies.items()
        if key != "readiness_cache" and key not in _PROOF_LANE_DEPENDENCY_KEYS
    }


def _dependency_ok(value: object) -> bool:
    if isinstance(value, Mapping):
        return bool(cast(Mapping[str, object], value).get("ok", True))
    return True


__all__: tuple[str, ...] = (
    "runtime_dependencies_for_health_surface",
    "split_runtime_and_proof_lane_dependencies",
)
