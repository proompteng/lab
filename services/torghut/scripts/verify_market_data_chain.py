from __future__ import annotations

import argparse
import base64
import json
import shlex
import subprocess
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Literal, Sequence


SCHEMA_VERSION = "torghut.market-data-chain-smoke.v1"
DEFAULT_TOPICS = (
    "torghut.trades.v1",
    "torghut.quotes.v1",
    "torghut.bars.1m.v1",
    "torghut.ta.bars.1s.v1",
    "torghut.ta.signals.v1",
    "torghut.ta.status.v1",
)
DEFAULT_CLICKHOUSE_QUERY = """
SELECT 'ta_signals' AS table, source, count(), max(event_ts), max(ingest_ts)
FROM torghut.ta_signals
GROUP BY source
UNION ALL
SELECT 'ta_microbars' AS table, source, count(), max(event_ts), max(ingest_ts)
FROM torghut.ta_microbars
GROUP BY source
ORDER BY table, source
FORMAT TSVWithNames
""".strip()


@dataclass(frozen=True)
class TopicOffset:
    topic: str
    partition: int
    offset: int


@dataclass(frozen=True)
class ConsumerGroupLag:
    group: str
    topic: str
    partition: int
    current_offset: int
    log_end_offset: int
    lag: int


@dataclass(frozen=True)
class LatestKafkaMessage:
    topic: str
    partition: int
    offset: int
    timestamp_type: str
    timestamp_ms: int
    key: str | None


@dataclass(frozen=True)
class ClickHouseFreshnessRow:
    table: str
    source: str
    row_count: int
    latest_event_ts: str | None
    latest_ingest_ts: str | None


def parse_topic_offsets(output: str) -> list[TopicOffset]:
    rows: list[TopicOffset] = []
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("===", "---")):
            continue
        parts = line.split(":")
        if len(parts) != 3:
            continue
        topic, partition, offset = parts
        if not partition.isdigit() or not offset.isdigit():
            continue
        rows.append(
            TopicOffset(topic=topic, partition=int(partition), offset=int(offset))
        )
    return rows


def parse_consumer_group_lag(output: str) -> list[ConsumerGroupLag]:
    rows: list[ConsumerGroupLag] = []
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("Consumer group", "GROUP", "===", "---")):
            continue
        parts = line.split()
        if len(parts) < 6:
            continue
        group, topic, partition, current_offset, log_end_offset, lag = parts[:6]
        if not (
            partition.isdigit()
            and current_offset.lstrip("-").isdigit()
            and log_end_offset.lstrip("-").isdigit()
            and lag.lstrip("-").isdigit()
        ):
            continue
        rows.append(
            ConsumerGroupLag(
                group=group,
                topic=topic,
                partition=int(partition),
                current_offset=int(current_offset),
                log_end_offset=int(log_end_offset),
                lag=int(lag),
            )
        )
    return rows


def parse_latest_kafka_messages(output: str) -> list[LatestKafkaMessage]:
    rows: list[LatestKafkaMessage] = []
    current_topic: str | None = None
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if line.startswith("===") and line.endswith("==="):
            current_topic = line.strip("= ")
            continue
        if not line.startswith(("CreateTime:", "LogAppendTime:", "NoTimestampType:")):
            continue
        fields = line.split("\t")
        if len(fields) < 3 or current_topic is None:
            continue
        timestamp_type, timestamp = fields[0].split(":", 1)
        partition = _field_int(fields[1], "Partition")
        offset = _field_int(fields[2], "Offset")
        if partition is None or offset is None or not timestamp.isdigit():
            continue
        key = fields[3] if len(fields) > 3 and fields[3] != "null" else None
        rows.append(
            LatestKafkaMessage(
                topic=current_topic,
                partition=partition,
                offset=offset,
                timestamp_type=timestamp_type,
                timestamp_ms=int(timestamp),
                key=key,
            )
        )
    return rows


def parse_clickhouse_freshness(output: str) -> list[ClickHouseFreshnessRow]:
    rows: list[ClickHouseFreshnessRow] = []
    for index, raw_line in enumerate(output.splitlines()):
        line = raw_line.strip()
        if not line or index == 0 and line.startswith("table\t"):
            continue
        parts = line.split("\t")
        if len(parts) != 5 or not parts[2].isdigit():
            continue
        rows.append(
            ClickHouseFreshnessRow(
                table=parts[0],
                source=parts[1],
                row_count=int(parts[2]),
                latest_event_ts=parts[3] or None,
                latest_ingest_ts=parts[4] or None,
            )
        )
    return rows


def build_summary(
    *,
    generated_at: datetime,
    consumer_group_lag: Sequence[ConsumerGroupLag],
    topic_offsets: Sequence[TopicOffset],
    latest_messages: Sequence[LatestKafkaMessage],
    clickhouse_rows: Sequence[ClickHouseFreshnessRow],
    require_max_kafka_age_seconds: int | None = None,
    require_max_clickhouse_age_seconds: int | None = None,
) -> dict[str, object]:
    issues: list[str] = []
    max_group_lag = max((row.lag for row in consumer_group_lag), default=0)
    if max_group_lag > 0:
        issues.append("kafka_consumer_group_lag")

    latest_message_payloads = [
        {
            **asdict(row),
            "age_seconds": _age_seconds_from_epoch_ms(generated_at, row.timestamp_ms),
        }
        for row in latest_messages
    ]
    if require_max_kafka_age_seconds is not None:
        for row in latest_message_payloads:
            age = row["age_seconds"]
            if isinstance(age, int) and age > require_max_kafka_age_seconds:
                issues.append(f"kafka_topic_stale:{row['topic']}:{row['partition']}")

    clickhouse_payloads = [
        {
            **asdict(row),
            "latest_event_age_seconds": _age_seconds_from_clickhouse_ts(
                generated_at, row.latest_event_ts
            ),
            "latest_ingest_age_seconds": _age_seconds_from_clickhouse_ts(
                generated_at, row.latest_ingest_ts
            ),
        }
        for row in clickhouse_rows
    ]
    if require_max_clickhouse_age_seconds is not None:
        accepted_rows = [
            row
            for row in clickhouse_payloads
            if row["source"] == "ta" and row["table"] in {"ta_signals", "ta_microbars"}
        ]
        for row in accepted_rows:
            age = row["latest_event_age_seconds"]
            if isinstance(age, int) and age > require_max_clickhouse_age_seconds:
                issues.append(f"clickhouse_accepted_source_stale:{row['table']}")

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at.isoformat(),
        "status": "ok" if not issues else "degraded",
        "issues": sorted(set(issues)),
        "summary": {
            "kafka_consumer_group_max_lag": max_group_lag,
            "latest_kafka_message_count": len(latest_messages),
            "clickhouse_row_count": len(clickhouse_rows),
        },
        "kafka": {
            "consumer_group_lag": [asdict(row) for row in consumer_group_lag],
            "topic_offsets": [asdict(row) for row in topic_offsets],
            "latest_messages": latest_message_payloads,
        },
        "clickhouse": {
            "freshness": clickhouse_payloads,
        },
    }


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    topics = tuple(args.topic or DEFAULT_TOPICS)
    generated_at = datetime.now(UTC)

    kafka_password = read_kubernetes_secret(
        namespace=args.kafka_namespace,
        name=args.kafka_secret,
        key=args.kafka_password_key,
    )
    kafka_output = run_kafka_probe(
        namespace=args.kafka_namespace,
        pod=args.kafka_pod,
        bootstrap=args.kafka_bootstrap,
        username=args.kafka_username,
        password=kafka_password,
        group=args.ta_group,
        topics=topics,
    )
    clickhouse_password = read_kubernetes_secret(
        namespace=args.clickhouse_namespace,
        name=args.clickhouse_secret,
        key=args.clickhouse_password_key,
    )
    clickhouse_output = run_clickhouse_query(
        namespace=args.clickhouse_namespace,
        pod=args.clickhouse_pod,
        user=args.clickhouse_user,
        password=clickhouse_password,
        query=args.clickhouse_query,
    )
    summary = build_summary(
        generated_at=generated_at,
        consumer_group_lag=parse_consumer_group_lag(kafka_output),
        topic_offsets=parse_topic_offsets(kafka_output),
        latest_messages=parse_latest_kafka_messages(kafka_output),
        clickhouse_rows=parse_clickhouse_freshness(clickhouse_output),
        require_max_kafka_age_seconds=args.require_max_kafka_age_seconds,
        require_max_clickhouse_age_seconds=args.require_max_clickhouse_age_seconds,
    )
    print(format_summary(summary, args.format))
    return 0 if summary["status"] == "ok" else 2


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Smoke-test Torghut WS -> Kafka -> Flink TA -> ClickHouse freshness without printing secrets.",
    )
    parser.add_argument("--kafka-namespace", default="kafka")
    parser.add_argument("--kafka-pod", default="kafka-pool-a-0")
    parser.add_argument("--kafka-secret", default="torghut-ws")
    parser.add_argument("--kafka-password-key", default="password")
    parser.add_argument("--kafka-username", default="torghut-ws")
    parser.add_argument("--kafka-bootstrap", default="kafka-kafka-bootstrap.kafka:9092")
    parser.add_argument("--ta-group", default="torghut-ta-live")
    parser.add_argument(
        "--topic",
        action="append",
        help="Kafka topic to probe. Repeat to replace the default topic set.",
    )
    parser.add_argument("--clickhouse-namespace", default="torghut")
    parser.add_argument(
        "--clickhouse-pod", default="chi-torghut-clickhouse-default-0-0-0"
    )
    parser.add_argument("--clickhouse-secret", default="torghut-clickhouse-auth")
    parser.add_argument("--clickhouse-password-key", default="torghut_password")
    parser.add_argument("--clickhouse-user", default="torghut")
    parser.add_argument("--clickhouse-query", default=DEFAULT_CLICKHOUSE_QUERY)
    parser.add_argument("--require-max-kafka-age-seconds", type=int)
    parser.add_argument("--require-max-clickhouse-age-seconds", type=int)
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    return parser.parse_args(argv)


def read_kubernetes_secret(*, namespace: str, name: str, key: str) -> str:
    encoded = _run(
        [
            "kubectl",
            "get",
            "secret",
            "-n",
            namespace,
            name,
            "-o",
            f"jsonpath={{.data.{key}}}",
        ]
    ).strip()
    return base64.b64decode(encoded).decode("utf-8")


def run_kafka_probe(
    *,
    namespace: str,
    pod: str,
    bootstrap: str,
    username: str,
    password: str,
    group: str,
    topics: Sequence[str],
) -> str:
    topic_args = " ".join(shlex.quote(topic) for topic in topics)
    script = f"""
set -euo pipefail
CONFIG=/tmp/torghut-market-data-smoke.properties
trap 'rm -f "$CONFIG"' EXIT
cat > "$CONFIG"
echo "=== consumer_group ==="
bin/kafka-consumer-groups.sh --bootstrap-server {shlex.quote(bootstrap)} --command-config "$CONFIG" --describe --group {shlex.quote(group)} || true
echo "=== topic_offsets ==="
for topic in {topic_args}; do
  bin/kafka-get-offsets.sh --bootstrap-server {shlex.quote(bootstrap)} --command-config "$CONFIG" --topic "$topic" --time latest
done
echo "=== latest_messages ==="
for topic in {topic_args}; do
  echo "=== $topic ==="
  bin/kafka-get-offsets.sh --bootstrap-server {shlex.quote(bootstrap)} --command-config "$CONFIG" --topic "$topic" --time latest | while IFS=: read -r row_topic partition offset; do
    if [ "$offset" -gt 0 ]; then
      start=$((offset - 1))
      timeout 8 bin/kafka-console-consumer.sh --bootstrap-server {shlex.quote(bootstrap)} --command-config "$CONFIG" --topic "$row_topic" --partition "$partition" --offset "$start" --max-messages 1 --formatter org.apache.kafka.tools.consumer.DefaultMessageFormatter --formatter-property print.timestamp=true --formatter-property print.offset=true --formatter-property print.partition=true --formatter-property print.key=true --formatter-property print.value=false --timeout-ms 5000 || true
    fi
  done
done
""".strip()
    properties = "\n".join(
        (
            "security.protocol=SASL_PLAINTEXT",
            "sasl.mechanism=SCRAM-SHA-512",
            f'sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="{username}" password="{password}";',
            "",
        )
    )
    return _run(
        ["kubectl", "exec", "-i", "-n", namespace, pod, "--", "bash", "-lc", script],
        input_text=properties,
    )


def run_clickhouse_query(
    *,
    namespace: str,
    pod: str,
    user: str,
    password: str,
    query: str,
) -> str:
    script = f"""
set -euo pipefail
read -r CLICKHOUSE_PASSWORD
SQL_FILE=/tmp/torghut-market-data-smoke.sql
trap 'rm -f "$SQL_FILE"' EXIT
cat >"$SQL_FILE" <<'SQL'
{query}
SQL
clickhouse-client --user {shlex.quote(user)} --password "$CLICKHOUSE_PASSWORD" < "$SQL_FILE"
""".strip()
    return _run(
        ["kubectl", "exec", "-i", "-n", namespace, pod, "--", "bash", "-lc", script],
        input_text=f"{password}\n",
    )


def format_summary(
    summary: dict[str, object],
    output_format: Literal["json", "markdown"],
) -> str:
    if output_format == "json":
        return json.dumps(summary, indent=2, sort_keys=True)
    issues = summary.get("issues")
    issue_text = (
        ", ".join(str(issue) for issue in issues)
        if isinstance(issues, list) and issues
        else "none"
    )
    lines = [
        "# Torghut Market Data Chain Smoke",
        f"- Status: `{summary.get('status')}`",
        f"- Issues: {issue_text}",
    ]
    nested_summary = summary.get("summary")
    if isinstance(nested_summary, dict):
        lines.extend(
            [
                f"- Kafka consumer group max lag: `{nested_summary.get('kafka_consumer_group_max_lag')}`",
                f"- Latest Kafka messages checked: `{nested_summary.get('latest_kafka_message_count')}`",
                f"- ClickHouse freshness rows checked: `{nested_summary.get('clickhouse_row_count')}`",
            ]
        )
    return "\n".join(lines)


def _run(cmd: Sequence[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(
        list(cmd),
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stdout.strip() or f"command failed: {cmd[0]}")
    return result.stdout


def _field_int(value: str, field: str) -> int | None:
    prefix = f"{field}:"
    if not value.startswith(prefix):
        return None
    raw = value.removeprefix(prefix)
    return int(raw) if raw.isdigit() else None


def _age_seconds_from_epoch_ms(now: datetime, timestamp_ms: int) -> int:
    timestamp = datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC)
    return max(0, int((now - timestamp).total_seconds()))


def _age_seconds_from_clickhouse_ts(now: datetime, value: str | None) -> int | None:
    parsed = _parse_clickhouse_ts(value)
    if parsed is None:
        return None
    return max(0, int((now - parsed).total_seconds()))


def _parse_clickhouse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = value.strip().replace(" ", "T", 1)
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


if __name__ == "__main__":
    raise SystemExit(main())
