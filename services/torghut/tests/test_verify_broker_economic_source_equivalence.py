from __future__ import annotations

import argparse
import json
from unittest.mock import patch

import pytest

from scripts import verify_broker_economic_source_equivalence as cli


def _payload(*, complete: bool) -> dict[str, object]:
    return {
        "schema_version": "torghut.broker-economic-source-comparison.v1",
        "proof_complete": complete,
    }


def test_cli_requires_timezone_and_fails_closed_when_requested(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(argparse.ArgumentTypeError, match="timezone"):
        cli._aware_datetime("2026-07-16T07:38:00")

    argv = [
        "verify",
        "--window-start",
        "2026-07-16T07:38:00Z",
        "--window-end",
        "2026-07-16T07:41:00Z",
        "--require-proof",
    ]
    with (
        patch("sys.argv", argv),
        patch.object(
            cli,
            "run_proof",
            return_value=_payload(complete=False),
        ),
    ):
        assert cli.main() == 1

    assert json.loads(capsys.readouterr().out)["proof_complete"] is False


def test_cli_succeeds_for_complete_source_equivalence(
    capsys: pytest.CaptureFixture[str],
) -> None:
    argv = [
        "verify",
        "--window-start",
        "2026-07-16T07:38:00Z",
        "--window-end",
        "2026-07-16T07:41:00Z",
        "--require-proof",
    ]
    with (
        patch("sys.argv", argv),
        patch.object(
            cli,
            "run_proof",
            return_value=_payload(complete=True),
        ),
    ):
        assert cli.main() == 0

    assert json.loads(capsys.readouterr().out)["proof_complete"] is True
