from __future__ import annotations

import logging

from tests.hypothesis_profiles import default_profile_name, load_default_hypothesis_profile

_ACTIVE_HYPOTHESIS_PROFILE = load_default_hypothesis_profile()


def pytest_configure() -> None:
    # CI teardown can invoke litellm/asyncio cleanup while streams are already closed.
    # Silence logger output and prevent logging exceptions from failing test shutdown.
    for logger_name in ("litellm", "asyncio"):
        logger = logging.getLogger(logger_name)
        logger.setLevel(logging.CRITICAL)
        logger.disabled = True

    logging.raiseExceptions = False


def pytest_report_header() -> list[str]:
    return [f'torghut hypothesis profile: {_ACTIVE_HYPOTHESIS_PROFILE or default_profile_name()}']
