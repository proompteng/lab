from __future__ import annotations

import pytest

from scripts import replay_broker_economic_ledger as replay_cli


def test_observation_and_publication_modes_are_mutually_exclusive() -> None:
    with pytest.raises(SystemExit):
        replay_cli._parse_args(
            [
                "--observe",
                "--publish-token",
                f"publish:{'a' * 64}",
            ]
        )


def test_default_mode_is_read_only_replay() -> None:
    args = replay_cli._parse_args([])

    assert args.observe is False
    assert args.publish_token is None
