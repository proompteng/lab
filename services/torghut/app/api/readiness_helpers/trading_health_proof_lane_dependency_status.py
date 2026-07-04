"""Dependency status projection for the Torghut trading health proof lane."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast

from app.config import settings

from .trading_health_proof_lane_model import TradingHealthProofLane, payload


def add_dependency_statuses(proof_lane: TradingHealthProofLane) -> None:
    payloads = proof_lane.payloads
    live_mode = settings.trading_mode == "live"
    empirical_jobs_required = (
        live_mode and settings.trading_empirical_jobs_health_required
    )
    empirical_jobs = payload(payloads, "empirical_jobs")
    dspy_runtime = payload(payloads, "dspy_runtime")
    live_submission_gate = payload(payloads, "live_submission_gate")
    proof_floor = payload(payloads, "proof_floor")
    quant_evidence = payload(payloads, "quant_evidence")
    proof_lane.dependencies["empirical_jobs"] = {
        "ok": bool(empirical_jobs.get("ready")) if empirical_jobs_required else True,
        "detail": (
            str(empirical_jobs.get("status") or "unknown")
            if live_mode
            else "not_required_in_non_live_mode"
        ),
        "authority": empirical_jobs.get("authority"),
        "required": empirical_jobs_required,
    }
    proof_lane.dependencies["dspy_runtime"] = _dspy_runtime_dependency(dspy_runtime)
    proof_lane.dependencies["live_submission_gate"] = {
        "ok": bool(live_submission_gate.get("allowed", False)),
        "detail": str(live_submission_gate.get("reason") or "unknown"),
        "capital_stage": live_submission_gate.get("capital_stage"),
    }
    proof_lane.dependencies["profitability_proof_floor"] = {
        "ok": str(proof_floor.get("route_state") or "") != "repair_only"
        if live_mode
        else True,
        "detail": str(proof_floor.get("route_state") or "unknown"),
        "capital_state": proof_floor.get("capital_state"),
        "required": live_mode,
    }
    proof_lane.dependencies["quant_evidence"] = {
        "ok": bool(quant_evidence.get("ok", True))
        if live_mode and bool(quant_evidence.get("required", False))
        else True,
        "detail": (
            str(quant_evidence.get("reason") or "unknown")
            if live_mode
            else "not_required_in_non_live_mode"
        ),
        "required": bool(quant_evidence.get("required", False)),
        "window": quant_evidence.get("window"),
    }


def _dspy_runtime_dependency(dspy_runtime: Mapping[str, object]) -> dict[str, object]:
    live_ready = bool(dspy_runtime.get("live_ready", False))
    active_mode = str(dspy_runtime.get("mode") or "").strip().lower() == "active"
    reasons = [
        str(item).strip()
        for item in cast(list[object], dspy_runtime.get("readiness_reasons") or [])
        if str(item).strip()
    ]
    return {
        "ok": live_ready if active_mode else True,
        "detail": "ready" if live_ready else ", ".join(reasons) or "not_ready",
        "artifact_hash": dspy_runtime.get("artifact_hash"),
    }
