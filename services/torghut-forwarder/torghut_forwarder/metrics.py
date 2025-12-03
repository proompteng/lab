from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

EVENTS_RECEIVED = Counter(
    "torghut_forwarder_events_received_total",
    "Events received from Alpaca by channel",
    labelnames=("channel",),
)
EVENTS_FORWARDED = Counter(
    "torghut_forwarder_events_forwarded_total",
    "Events forwarded to Kafka by channel",
    labelnames=("channel",),
)
DEDUP_DROPPED = Counter(
    "torghut_forwarder_events_dedup_dropped_total",
    "Events dropped because of deduplication",
    labelnames=("channel",),
)
PUBLISH_LATENCY = Histogram(
    "torghut_forwarder_publish_latency_seconds",
    "Seconds between ingest and publish",
    labelnames=("channel",),
    buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5, 10),
)
SUBSCRIPTION_READY = Gauge(
    "torghut_forwarder_subscription_ready",
    "1 when Alpaca stream subscribed, 0 otherwise",
)
PRODUCER_READY = Gauge(
    "torghut_forwarder_producer_ready",
    "1 when Kafka producer is connected",
)
RECONNECTS = Counter(
    "torghut_forwarder_reconnects_total",
    "Number of reconnect attempts to Alpaca stream",
)
