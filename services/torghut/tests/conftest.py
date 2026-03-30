from __future__ import annotations

import logging

from tests.hypothesis_profiles import default_profile_name, load_default_hypothesis_profile

_ACTIVE_HYPOTHESIS_PROFILE = load_default_hypothesis_profile()


def pytest_configure() -> None:
    # CI teardown can invoke litellm async cleanup logging after stdout/stderr are closed.
    # Force litellm's logger to warning-level so debug shutdown messages are not emitted.
    litellm_logger = logging.getLogger("litellm")
    litellm_logger.setLevel(logging.WARNING)


def pytest_report_header() -> list[str]:
    return [f'torghut hypothesis profile: {_ACTIVE_HYPOTHESIS_PROFILE or default_profile_name()}']
