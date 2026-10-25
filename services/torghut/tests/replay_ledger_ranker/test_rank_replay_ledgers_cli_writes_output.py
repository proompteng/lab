from __future__ import annotations

from tests.replay_ledger_ranker.support import (
    Path,
    _payload,
    _round_trip,
    json,
    pytest,
    rank_replay_ledgers_cli,
    sys,
)


def test_rank_replay_ledgers_cli_writes_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ledger_path = tmp_path / "ledger.json"
    output_path = tmp_path / "report.json"
    ledger_path.write_text(
        json.dumps(
            _payload(
                "cli-ledger",
                _round_trip(
                    day=18,
                    symbol="NVDA",
                    qty="1",
                    buy_price="100",
                    sell_price="101",
                    prefix="cli",
                ),
            )
        )
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "rank_replay_ledgers.py",
            str(ledger_path),
            "--output",
            str(output_path),
            "--limit",
            "1",
            "--target-net-pnl-per-day",
            "25",
            "--start-equity",
            "1000",
        ],
    )

    assert rank_replay_ledgers_cli.main() == 0
    report = json.loads(output_path.read_text())
    assert report["candidates"][0]["candidate_id"] == "cli-ledger"
    assert report["policy"]["target_net_pnl_per_day"] == "25"
    assert report["policy"]["start_equity"] == "1000"


def test_rank_replay_ledgers_cli_supports_glob_and_stdout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    ledger_path = tmp_path / "ledger.json"
    ledger_path.write_text(
        json.dumps(
            _payload(
                "glob-ledger",
                _round_trip(
                    day=18,
                    symbol="NVDA",
                    qty="1",
                    buy_price="100",
                    sell_price="101",
                    prefix="glob",
                ),
            )
        )
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["rank_replay_ledgers.py", "--ledger-glob", str(tmp_path / "*.json")],
    )

    assert rank_replay_ledgers_cli.main() == 0
    report = json.loads(capsys.readouterr().out)
    assert report["candidates"][0]["candidate_id"] == "glob-ledger"


def test_rank_replay_ledgers_cli_requires_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "argv", ["rank_replay_ledgers.py"])

    with pytest.raises(SystemExit, match="provide at least one ledger path"):
        rank_replay_ledgers_cli.main()
