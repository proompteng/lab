import pytest


@pytest.fixture(autouse=True)
def reuse_profiles_in_runner(reuse_execution_profiles: None) -> None:
    """Exercise runner behavior without regenerating identical profile fixtures."""
