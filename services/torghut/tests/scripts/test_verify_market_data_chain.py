from __future__ import annotations

from datetime import UTC, datetime

from scripts.verify_market_data_chain import (
    ClickHouseFreshnessRow,
    ConsumerGroupLag,
    DEFAULT_TOPICS,
    LatestKafkaMessage,
    TopicOffset,
    build_summary,
    format_summary,
    parse_clickhouse_freshness,
    parse_args,
    parse_consumer_group_lag,
    parse_latest_kafka_messages,
    parse_topic_offsets,
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


def test_parse_args_replaces_default_topics_when_topic_is_provided() -> None:
    defaults = parse_args([])
    custom = parse_args(["--topic", "custom.one", "--topic", "custom.two"])

    assert defaults.topic is None
    assert tuple(defaults.topic or DEFAULT_TOPICS) == DEFAULT_TOPICS
    assert custom.topic == ["custom.one", "custom.two"]


def test_build_summary_degrades_on_group_lag_and_accepted_clickhouse_staleness() -> None:
    summary = build_summary(
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
        topic_offsets=[TopicOffset(topic="torghut.trades.v1", partition=0, offset=10)],
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
        require_max_kafka_age_seconds=300,
        require_max_clickhouse_age_seconds=300,
    )

    assert summary["status"] == "degraded"
    assert summary["issues"] == [
        "clickhouse_accepted_source_stale:ta_signals",
        "kafka_consumer_group_lag",
        "kafka_topic_stale:torghut.trades.v1:0",
    ]
    assert format_summary(summary, "markdown").startswith(
        "# Torghut Market Data Chain Smoke"
    )
