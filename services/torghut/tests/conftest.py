from __future__ import annotations

from tests.hypothesis_profiles import default_profile_name, load_default_hypothesis_profile

_ACTIVE_HYPOTHESIS_PROFILE = load_default_hypothesis_profile()


def pytest_report_header() -> list[str]:
    return [f'torghut hypothesis profile: {_ACTIVE_HYPOTHESIS_PROFILE or default_profile_name()}']
