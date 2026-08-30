#!/usr/bin/env python3
"""Feedback risk-profile helpers for whitepaper autoresearch orchestration."""

from __future__ import annotations

from typing import Any, Mapping


def _feedback_risk_profile_key_payload(
    *,
    family_template_id: str,
    runtime_strategy_name: str,
    execution_profile_id: str,
    universe_key: str,
    signal_key: str,
) -> Mapping[str, Any]:
    return {
        "family_template_id": family_template_id,
        "runtime_strategy_name": runtime_strategy_name,
        "execution_profile_id": execution_profile_id,
        "universe_key": universe_key,
        "signal_key": signal_key,
    }


__all__ = ["_feedback_risk_profile_key_payload"]
