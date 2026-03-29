from __future__ import annotations

import os

from hypothesis import HealthCheck, Verbosity, settings

_REGISTERED = False


def register_hypothesis_profiles() -> None:
    global _REGISTERED
    if _REGISTERED:
        return
    settings.register_profile(
        'ci_fast',
        max_examples=50,
        deadline=1000,
        suppress_health_check=[HealthCheck.function_scoped_fixture],
    )
    settings.register_profile(
        'ci_stateful',
        max_examples=40,
        stateful_step_count=25,
        deadline=1000,
        suppress_health_check=[HealthCheck.function_scoped_fixture],
    )
    settings.register_profile(
        'nightly_deep',
        max_examples=200,
        stateful_step_count=75,
        deadline=None,
        suppress_health_check=[HealthCheck.function_scoped_fixture],
    )
    settings.register_profile(
        'local_debug',
        max_examples=75,
        stateful_step_count=35,
        deadline=1000,
        print_blob=True,
        verbosity=Verbosity.verbose,
        suppress_health_check=[HealthCheck.function_scoped_fixture],
    )
    _REGISTERED = True


def default_profile_name() -> str:
    explicit = os.environ.get('TORGHUT_HYPOTHESIS_PROFILE')
    if explicit:
        return explicit
    if os.environ.get('GITHUB_ACTIONS') == 'true' or os.environ.get('CI') == 'true':
        return 'ci_fast'
    return 'local_debug'


def load_default_hypothesis_profile() -> str:
    register_hypothesis_profiles()
    profile_name = default_profile_name()
    settings.load_profile(profile_name)
    return profile_name
