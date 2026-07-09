from __future__ import annotations

import json
from datetime import UTC, datetime, tzinfo
from typing import Sequence, cast

import pytest

from scripts.verify_market_data_chain import (
    ClickHouseFreshnessRow,
    ConsumerGroupLag,
    DEFAULT_TOPICS,
    FreshnessThresholds,
    KafkaProbeConfig,
    LatestKafkaMessage,
    MarketDataChainProbe,
    TopicOffset,
    _run,
    build_summary,
    format_summary,
    main,
    parse_clickhouse_freshness,
    parse_args,
    parse_consumer_group_lag,
    parse_latest_kafka_messages,
    parse_topic_offsets,
    read_kubernetes_secret,
    resolve_freshness_market_session_state,
    run_clickhouse_query,
    run_kafka_probe,
)


def test_parse_consumer_group_lag_skips_status_lines() -> None:
    output = """
Consumer group 'torghut-ta-live' has no active members.

GROUP           TOPIC              PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
torghut-ta-live torghut.trades.v1  0          100             100             0
torghut-ta-live torghut.quotes.v1  2          198             200             2
"""

    assert parse_consumer_group_lag(output) == [
        ConsumerGroupLag(
            group="torghut-ta-live",
            topic="torghut.trades.v1",
            partition=0,
            current_offset=100,
            log_end_offset=100,
            lag=0,
        ),
        ConsumerGroupLag(
            group="torghut-ta-live",
            topic="torghut.quotes.v1",
            partition=2,
            current_offset=198,
            log_end_offset=200,
            lag=2,
        ),
    ]


def test_parse_topic_offsets_reads_kafka_get_offsets_rows() -> None:
    output = """
=== topic_offsets ===
torghut.trades.v1:0:4195924
torghut.trades.v1:1:4519705
ignored
"""

    assert parse_topic_offsets(output) == [
        TopicOffset(topic="torghut.trades.v1", partition=0, offset=4195924),
        TopicOffset(topic="torghut.trades.v1", partition=1, offset=4519705),
    ]


def test_parse_latest_kafka_messages_uses_topic_section_and_metadata() -> None:
    output = """
=== latest_messages ===
=== torghut.trades.v1 ===
CreateTime:1783544335234\tPartition:1\tOffset:4519704\tAMD
Processed a total of 1 messages
=== torghut.ta.status.v1 ===
CreateTime:1783561193358\tPartition:0\tOffset:79160\tta
"""

    assert parse_latest_kafka_messages(output) == [
        LatestKafkaMessage(
            topic="torghut.trades.v1",
            partition=1,
            offset=4519704,
            timestamp_type="CreateTime",
            timestamp_ms=1783544335234,
            key="AMD",
        ),
        LatestKafkaMessage(
            topic="torghut.ta.status.v1",
            partition=0,
            offset=79160,
            timestamp_type="CreateTime",
            timestamp_ms=1783561193358,
            key="ta",
        ),
    ]


def test_parse_clickhouse_freshness_reads_tsv_with_names() -> None:
    output = """table\tsource\tcount()\tmax(event_ts)\tmax(ingest_ts)
ta_signals\tta\t1411008\t2026-07-08 20:57:00.000\t2026-07-08 20:58:55.269
ta_microbars\tta\t1412773\t2026-07-08 20:56:30.000\t2026-07-08 20:58:55.269
"""

    assert parse_clickhouse_freshness(output) == [
        ClickHouseFreshnessRow(
            table="ta_signals",
            source="ta",
            row_count=1411008,
            latest_event_ts="2026-07-08 20:57:00.000",
            latest_ingest_ts="2026-07-08 20:58:55.269",
        ),
        ClickHouseFreshnessRow(
            table="ta_microbars",
            source="ta",
            row_count=1412773,
            latest_event_ts="2026-07-08 20:56:30.000",
            latest_ingest_ts="2026-07-08 20:58:55.269",
        ),
    ]


def test_parsers_skip_malformed_rows() -> None:
    assert parse_topic_offsets("topic:not-int:10\ntopic:0:not-int\n") == []
    assert parse_consumer_group_lag("group topic\nbad topic x y z n\n") == []
    assert (
        parse_latest_kafka_messages(
            "CreateTime:1783544335234\tPartition:1\tOffset:9\n"
            "=== torghut.trades.v1 ===\n"
            "CreateTime:bad\tPartition:1\tOffset:9\n"
            "CreateTime:1783544335234\tPartition:x\tOffset:9\n"
        )
        == []
    )
    assert parse_clickhouse_freshness("ta_signals\tta\tbad\t\t\nshort\trow\n") == []


def test_parse_args_replaces_default_topics_when_topic_is_provided() -> None:
    defaults = parse_args([])
    custom = parse_args(["--topic", "custom.one", "--topic", "custom.two"])

    assert defaults.topic is None
    assert tuple(defaults.topic or DEFAULT_TOPICS) == DEFAULT_TOPICS
    assert defaults.freshness_market_session == "auto"
    assert custom.topic == ["custom.one", "custom.two"]


def test_resolve_freshness_market_session_state_uses_regular_nyse_hours() -> None:
    assert (
        resolve_freshness_market_session_state(
            datetime(2026, 7, 8, 15, 0, tzinfo=UTC),
            "auto",
        )
        == "regular_open"
    )
    assert (
        resolve_freshness_market_session_state(
            datetime(2026, 7, 9, 6, 0, tzinfo=UTC),
            "auto",
        )
        == "outside_regular_session"
    )
    assert (
        resolve_freshness_market_session_state(
            datetime(2026, 7, 8, 15, 0, tzinfo=UTC),
            "outside_regular_session",
        )
        == "outside_regular_session"
    )


def test_resolve_freshness_market_session_state_uses_market_holidays() -> None:
    assert (
        resolve_freshness_market_session_state(
            datetime(2026, 7, 3, 15, 0, tzinfo=UTC),
            "auto",
        )
        == "outside_regular_session"
    )


def test_resolve_freshness_market_session_state_handles_early_closes() -> None:
    assert (
        resolve_freshness_market_session_state(
            datetime(2026, 11, 27, 17, 30, tzinfo=UTC),
            "auto",
        )
        == "regular_open"
    )
    assert (
        resolve_freshness_market_session_state(
            datetime(2026, 11, 27, 18, 30, tzinfo=UTC),
            "auto",
        )
        == "outside_regular_session"
    )
    assert (
        resolve_freshness_market_session_state(
            datetime(2026, 12, 24, 18, 30, tzinfo=UTC),
            "auto",
        )
        == "outside_regular_session"
    )


def test_read_kubernetes_secret_decodes_without_exposing_encoded_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[Sequence[str]] = []

    def fake_run(cmd: Sequence[str], *, input_text: str | None = None) -> str:
        calls.append(cmd)
        assert input_text is None
        return "c2VjcmV0Cg=="

    monkeypatch.setattr("scripts.verify_market_data_chain._run", fake_run)

    assert read_kubernetes_secret(
        namespace="ns", name="secret-name", key="password"
    ) == ("secret\n")
    assert calls == [
        [
            "kubectl",
            "get",
            "secret",
            "-n",
            "ns",
            "secret-name",
            "-o",
            "jsonpath={.data.password}",
        ]
    ]


def test_run_kafka_probe_passes_secret_on_stdin_and_quotes_shell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[Sequence[str], str | None]] = []

    def fake_run(cmd: Sequence[str], *, input_text: str | None = None) -> str:
        calls.append((cmd, input_text))
        return "kafka-output"

    monkeypatch.setattr("scripts.verify_market_data_chain._run", fake_run)

    output = run_kafka_probe(
        KafkaProbeConfig(
            namespace="kafka",
            pod="kafka-0",
            bootstrap="kafka:9092",
            username="torghut-ws",
            group="torghut-ta-live",
            topics=("torghut.trades.v1", "topic with space"),
        ),
        password="kafka-password",
    )

    assert output == "kafka-output"
    cmd, input_text = calls[0]
    assert cmd[:6] == ["kubectl", "exec", "-i", "-n", "kafka", "kafka-0"]
    assert "topic with space" in cmd[-1]
    assert 'password="kafka-password"' in str(input_text)
    assert "security.protocol=SASL_PLAINTEXT" in str(input_text)


def test_run_clickhouse_query_passes_password_and_query_via_stdin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[Sequence[str], str | None]] = []

    def fake_run(cmd: Sequence[str], *, input_text: str | None = None) -> str:
        calls.append((cmd, input_text))
        return "table\tsource\tcount()\tmax(event_ts)\tmax(ingest_ts)\n"

    monkeypatch.setattr("scripts.verify_market_data_chain._run", fake_run)

    output = run_clickhouse_query(
        namespace="torghut",
        pod="clickhouse-0",
        user="torghut",
        password="clickhouse-password",
        query="SELECT 1",
    )

    assert output.startswith("table\t")
    cmd, input_text = calls[0]
    assert cmd[:6] == ["kubectl", "exec", "-i", "-n", "torghut", "clickhouse-0"]
    assert "SELECT 1" in cmd[-1]
    assert input_text == "clickhouse-password\n"


def test_build_summary_degrades_on_group_lag_and_accepted_clickhouse_staleness() -> (
    None
):
    summary = build_summary(
        MarketDataChainProbe(
            generated_at=datetime(2026, 7, 8, 21, 10, tzinfo=UTC),
            consumer_group_lag=[
                ConsumerGroupLag(
                    group="torghut-ta-live",
                    topic="torghut.trades.v1",
                    partition=0,
                    current_offset=9,
                    log_end_offset=10,
                    lag=1,
                )
            ],
            topic_offsets=[
                TopicOffset(topic="torghut.trades.v1", partition=0, offset=10)
            ],
            latest_messages=[
                LatestKafkaMessage(
                    topic="torghut.trades.v1",
                    partition=0,
                    offset=9,
                    timestamp_type="CreateTime",
                    timestamp_ms=1783544335000,
                    key="AMD",
                )
            ],
            clickhouse_rows=[
                ClickHouseFreshnessRow(
                    table="ta_signals",
                    source="ta",
                    row_count=10,
                    latest_event_ts="2026-07-08 20:57:00.000",
                    latest_ingest_ts="2026-07-08 20:58:55.269",
                )
            ],
        ),
        thresholds=FreshnessThresholds(
            kafka_age_seconds=300,
            clickhouse_age_seconds=300,
        ),
    )

    assert summary["status"] == "degraded"
    assert summary["issues"] == [
        "clickhouse_accepted_source_missing:ta_microbars",
        "clickhouse_accepted_source_stale:ta_signals",
        "kafka_consumer_group_lag",
        "kafka_topic_stale:torghut.trades.v1:0",
    ]
    assert format_summary(summary, "markdown").startswith(
        "# Torghut Market Data Chain Smoke"
    )


def test_build_summary_degrades_when_required_kafka_evidence_is_missing() -> None:
    summary = build_summary(
        MarketDataChainProbe(
            generated_at=datetime(2026, 7, 8, 21, 10, tzinfo=UTC),
            consumer_group_lag=[],
            topic_offsets=[
                TopicOffset(topic="torghut.trades.v1", partition=0, offset=10)
            ],
            latest_messages=[],
            clickhouse_rows=[],
        ),
        thresholds=FreshnessThresholds(kafka_age_seconds=300),
    )

    assert summary["status"] == "degraded"
    assert summary["issues"] == [
        "kafka_consumer_group_lag_missing",
        "kafka_topic_evidence_missing:torghut.trades.v1:0",
    ]


def test_build_summary_degrades_when_required_clickhouse_rows_are_missing() -> None:
    summary = build_summary(
        MarketDataChainProbe(
            generated_at=datetime(2026, 7, 8, 21, 10, tzinfo=UTC),
            consumer_group_lag=[],
            topic_offsets=[],
            latest_messages=[],
            clickhouse_rows=[
                ClickHouseFreshnessRow(
                    table="ta_signals",
                    source="ta",
                    row_count=10,
                    latest_event_ts="2026-07-08 21:09:00.000",
                    latest_ingest_ts="2026-07-08 21:09:05.000",
                )
            ],
        ),
        thresholds=FreshnessThresholds(clickhouse_age_seconds=300),
    )

    assert summary["status"] == "degraded"
    assert summary["issues"] == ["clickhouse_accepted_source_missing:ta_microbars"]


def test_build_summary_suppresses_age_only_staleness_outside_regular_session() -> None:
    summary = build_summary(
        MarketDataChainProbe(
            generated_at=datetime(2026, 7, 9, 6, 10, tzinfo=UTC),
            consumer_group_lag=[
                ConsumerGroupLag(
                    group="torghut-ta-live",
                    topic="torghut.trades.v1",
                    partition=0,
                    current_offset=10,
                    log_end_offset=10,
                    lag=0,
                )
            ],
            topic_offsets=[
                TopicOffset(topic="torghut.trades.v1", partition=0, offset=10)
            ],
            latest_messages=[
                LatestKafkaMessage(
                    topic="torghut.trades.v1",
                    partition=0,
                    offset=9,
                    timestamp_type="CreateTime",
                    timestamp_ms=1783544335000,
                    key="AMD",
                )
            ],
            clickhouse_rows=[
                ClickHouseFreshnessRow(
                    table="ta_signals",
                    source="ta",
                    row_count=10,
                    latest_event_ts="2026-07-08 20:57:00.000",
                    latest_ingest_ts="2026-07-09 05:54:57.345",
                ),
                ClickHouseFreshnessRow(
                    table="ta_microbars",
                    source="ta",
                    row_count=10,
                    latest_event_ts="2026-07-08 20:57:00.000",
                    latest_ingest_ts="2026-07-09 05:54:57.345",
                ),
            ],
        ),
        thresholds=FreshnessThresholds(
            kafka_age_seconds=300,
            clickhouse_age_seconds=300,
            market_session_state="outside_regular_session",
            market_session_source="auto",
        ),
    )

    nested_summary = cast(dict[str, object], summary["summary"])
    assert summary["status"] == "ok"
    assert summary["issues"] == []
    assert nested_summary["freshness_age_enforced"] is False
    assert nested_summary["suppressed_freshness_age_issues"] == [
        "clickhouse_accepted_source_stale:ta_microbars",
        "clickhouse_accepted_source_stale:ta_signals",
        "kafka_topic_stale:torghut.trades.v1:0",
    ]


def test_build_summary_handles_missing_and_zulu_clickhouse_timestamps() -> None:
    summary = build_summary(
        MarketDataChainProbe(
            generated_at=datetime(2026, 7, 8, 21, 10, tzinfo=UTC),
            consumer_group_lag=[],
            topic_offsets=[],
            latest_messages=[],
            clickhouse_rows=[
                ClickHouseFreshnessRow(
                    table="ta_signals",
                    source="ta",
                    row_count=1,
                    latest_event_ts=None,
                    latest_ingest_ts="2026-07-08T21:09:00Z",
                )
            ],
        ),
        thresholds=FreshnessThresholds(clickhouse_age_seconds=300),
    )

    clickhouse = cast(dict[str, object], summary["clickhouse"])
    freshness_rows = cast(list[dict[str, object]], clickhouse["freshness"])
    freshness = freshness_rows[0]
    assert freshness["latest_event_age_seconds"] is None
    assert freshness["latest_ingest_age_seconds"] == 60


def test_format_summary_json_is_stable() -> None:
    summary = build_summary(
        MarketDataChainProbe(
            generated_at=datetime(2026, 7, 8, 21, 10, tzinfo=UTC),
            consumer_group_lag=[],
            topic_offsets=[],
            latest_messages=[],
            clickhouse_rows=[],
        )
    )

    encoded = format_summary(summary, "json")

    assert json.loads(encoded)["schema_version"] == "torghut.market-data-chain-smoke.v1"


def test_run_returns_stdout_and_raises_on_failure() -> None:
    assert _run(["python", "-c", "print('ok')"]) == "ok\n"

    with pytest.raises(RuntimeError, match="bad"):
        _run(["python", "-c", "import sys; print('bad'); sys.exit(2)"])


def test_main_orchestrates_kafka_clickhouse_and_returns_status(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    secret_calls: list[tuple[str, str, str]] = []
    kafka_configs: list[KafkaProbeConfig] = []

    def fake_secret(*, namespace: str, name: str, key: str) -> str:
        secret_calls.append((namespace, name, key))
        return f"{name}-password"

    def fake_kafka_probe(config: KafkaProbeConfig, *, password: str) -> str:
        kafka_configs.append(config)
        assert password == "torghut-ws-password"
        return """
GROUP TOPIC PARTITION CURRENT-OFFSET LOG-END-OFFSET LAG
torghut-ta-live torghut.trades.v1 0 10 10 0
=== topic_offsets ===
torghut.trades.v1:0:10
=== latest_messages ===
=== torghut.trades.v1 ===
CreateTime:1783545000000\tPartition:0\tOffset:9\tAMD
"""

    def fake_clickhouse_query(
        *,
        namespace: str,
        pod: str,
        user: str,
        password: str,
        query: str,
    ) -> str:
        assert (namespace, pod, user, password) == (
            "torghut",
            "chi-torghut-clickhouse-default-0-0-0",
            "torghut",
            "torghut-clickhouse-auth-password",
        )
        assert "ta_signals" in query
        return """table\tsource\tcount()\tmax(event_ts)\tmax(ingest_ts)
ta_signals\tta\t1\t2026-07-08 21:09:00.000\t2026-07-08 21:09:30.000
"""

    monkeypatch.setattr(
        "scripts.verify_market_data_chain.datetime",
        _FixedDatetime,
    )
    monkeypatch.setattr(
        "scripts.verify_market_data_chain.read_kubernetes_secret",
        fake_secret,
    )
    monkeypatch.setattr(
        "scripts.verify_market_data_chain.run_kafka_probe", fake_kafka_probe
    )
    monkeypatch.setattr(
        "scripts.verify_market_data_chain.run_clickhouse_query",
        fake_clickhouse_query,
    )

    exit_code = main(["--topic", "torghut.trades.v1", "--format", "json"])

    payload = json.loads(capsys.readouterr().out)
    assert exit_code == 0
    assert payload["status"] == "ok"
    assert secret_calls == [
        ("kafka", "torghut-ws", "password"),
        ("torghut", "torghut-clickhouse-auth", "torghut_password"),
    ]
    assert kafka_configs[0].topics == ("torghut.trades.v1",)


class _FixedDatetime(datetime):
    @classmethod
    def now(cls, tz: tzinfo | None = None) -> datetime:
        return datetime(2026, 7, 8, 21, 10, tzinfo=tz or UTC)
