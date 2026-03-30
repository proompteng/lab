from __future__ import annotations

import asyncio
import logging

from tests.hypothesis_profiles import default_profile_name, load_default_hypothesis_profile

_ACTIVE_HYPOTHESIS_PROFILE = load_default_hypothesis_profile()


def pytest_configure() -> None:
    # Keep pytest output deterministic even if async logging callbacks are noisy.
    for logger_name in ("litellm", "asyncio"):
        logging.getLogger(logger_name).setLevel(logging.ERROR)


def pytest_sessionfinish(session, exitstatus):  # noqa: ANN001, ARG001
    # Litellm registers an atexit cleanup callback that can fail when no event loop is
    # active and standard streams are already closed. Run the cleanup explicitly here so
    # atexit exits cleanly without creating a fresh loop.
    try:
        from litellm.llms.custom_httpx.async_client_cleanup import close_litellm_async_clients
    except Exception:
        return

    try:
        try:
            loop = asyncio.get_event_loop()
            if loop.is_closed():
                loop = asyncio.new_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()

        asyncio.set_event_loop(loop)
        loop.run_until_complete(close_litellm_async_clients())
    except Exception:
        return


def pytest_report_header() -> list[str]:
    return [f'torghut hypothesis profile: {_ACTIVE_HYPOTHESIS_PROFILE or default_profile_name()}']
