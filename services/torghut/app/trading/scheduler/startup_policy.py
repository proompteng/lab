"""Explicit scheduler startup policy checks."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def resolve_trading_shorts_startup_policy(
    *,
    raw_env_value: str | None,
    configured_setting: bool,
) -> bool:
    env_name = "TRADING_ALLOW_SHORTS"
    if raw_env_value is None:
        raise RuntimeError(
            f"{env_name} must be explicitly set before scheduler startup"
        )
    normalized = raw_env_value.strip().lower()
    if normalized in {"1", "true", "t", "yes", "on", "y"}:
        configured_env_value = True
    elif normalized in {"0", "false", "f", "no", "off", "n"}:
        configured_env_value = False
    else:
        raise ValueError(
            f"{env_name} has invalid boolean value: {raw_env_value!r}; expected one of "
            "1, true, false, 0, on, off, yes, no"
        )
    if configured_env_value != configured_setting:
        raise RuntimeError(
            f"{env_name} resolved to {configured_env_value} but settings value is "
            f"{configured_setting}; expected a single source of truth"
        )
    logger.info(
        "Startup short policy explicit: %s=%s (declared=%s)",
        env_name,
        configured_setting,
        raw_env_value,
    )
    return configured_setting
