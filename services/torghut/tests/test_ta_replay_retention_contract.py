from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping
from unittest import TestCase

import yaml

from scripts import ta_replay_runner


_REPO_ROOT = Path(__file__).resolve().parents[3]
_MIN_PROOF_RETENTION_MS = 35 * 86_400_000


def _kafka_topics(path: Path) -> dict[str, Mapping[str, Any]]:
    payloads = yaml.safe_load_all(path.read_text(encoding="utf-8"))
    topics: dict[str, Mapping[str, Any]] = {}
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        if payload.get("kind") != "KafkaTopic":
            continue
        metadata = payload.get("metadata")
        if not isinstance(metadata, dict):
            continue
        name = metadata.get("name")
        if isinstance(name, str) and name:
            topics[name] = payload
    return topics


def _retention_ms(topic: Mapping[str, Any]) -> int:
    spec = topic.get("spec")
    config = spec.get("config") if isinstance(spec, dict) else None
    value = config.get("retention.ms") if isinstance(config, dict) else None
    return int(value)


class TestTaReplayRetentionContract(TestCase):
    def test_live_and_sim_replay_sources_cover_25_trading_day_proof_window(
        self,
    ) -> None:
        required_topics = (
            "trades.v1",
            "quotes.v1",
            "bars.1m.v1",
            "ta.bars.1s.v1",
            "ta.signals.v1",
        )
        for manifest_name, prefix in (
            ("torghut-topics.yaml", "torghut"),
            ("torghut-sim-topics.yaml", "torghut.sim"),
        ):
            topics = _kafka_topics(
                _REPO_ROOT / "argocd" / "applications" / "kafka" / manifest_name
            )
            for suffix in required_topics:
                topic_name = f"{prefix}.{suffix}"
                self.assertGreaterEqual(
                    _retention_ms(topics[topic_name]),
                    _MIN_PROOF_RETENTION_MS,
                    topic_name,
                )

    def test_clickhouse_ta_ttl_matches_replay_proof_retention(self) -> None:
        self.assertEqual(
            ta_replay_runner.CLICKHOUSE_TA_TTL_DAYS,
            {
                "ta_microbars": 35,
                "ta_signals": 35,
            },
        )
