from __future__ import annotations

import asyncio
import hashlib
import signal
import time
from datetime import datetime, timezone
from itertools import count
from typing import Any, Dict, Hashable, Iterable, Sequence

import orjson
from aiokafka import AIOKafkaProducer
from alpaca.data.live import StockDataStream
from tenacity import RetryError, retry, stop_after_delay, wait_exponential

from .config import Settings, get_settings
from .dedup import DedupCache
from .envelope import build_envelope, payload_to_dict, to_iso
from .health import HealthServer, RuntimeState
from .logger import configure_logging, get_logger
from .metrics import (
    DEDUP_DROPPED,
    EVENTS_FORWARDED,
    EVENTS_RECEIVED,
    PRODUCER_READY,
    PUBLISH_LATENCY,
    RECONNECTS,
    SUBSCRIPTION_READY,
)

logger = get_logger(__name__)


def _safe_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if hasattr(value, "to_pydatetime"):
        try:
            return value.to_pydatetime()
        except Exception:
            return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


def _event_timestamp(payload: Any) -> datetime | None:
    for attr in ("timestamp", "t", "event_time", "sent_at"):
        if hasattr(payload, attr):
            ts = getattr(payload, attr)
            dt = _safe_datetime(ts)
            if dt:
                return dt
    if isinstance(payload, dict) and "t" in payload:
        return _safe_datetime(payload["t"])
    return None


def _dedup_key(channel: str, symbol: str, payload: Any) -> Hashable:
    data = payload_to_dict(payload)
    if channel == "trades":
        return data.get("i") or (data.get("t"), symbol)
    if channel == "quotes":
        return (data.get("t"), symbol)
    if channel == "bars":
        return (data.get("t"), symbol, data.get("is_final"))
    if channel == "trade_updates":
        return data.get("order_id") or data.get("i") or (data.get("t"), symbol)
    return (channel, symbol, data.get("t"))


def _topic_for(channel: str, settings: Settings) -> str:
    return {
        "trades": settings.topic_trades,
        "quotes": settings.topic_quotes,
        "bars": settings.topic_bars,
        "trade_updates": settings.topic_status,
        "status": settings.topic_status,
    }.get(channel, settings.topic_status)


def _symbol_list(symbols: Iterable[str]) -> list[str]:
    return [s.upper() for s in symbols]


def _symbol_partitioner(
    key: bytes | None, all_partitions: Sequence[int], available: Sequence[int] | None = None
) -> int:
    partitions = list(available or all_partitions)
    if not partitions:
        raise ValueError("No partitions available for topic")
    symbol_bytes = b""
    if key:
        symbol_bytes = key.split(b"|", 1)[0]
    digest = int.from_bytes(hashlib.sha256(symbol_bytes or b"*").digest()[:4], "big")
    return partitions[digest % len(partitions)]


async def _send_status(
    producer: AIOKafkaProducer,
    settings: Settings,
    seq: int,
    status: str,
    detail: Dict[str, Any] | None = None,
) -> None:
    payload = {"status": status, **(detail or {})}
    topic = settings.topic_status
    envelope = build_envelope(
        channel="status",
        symbol="*",
        seq=seq,
        payload=payload,
        event_ts=datetime.now(timezone.utc),
        is_final=True,
        source="forwarder",
        key=status,
    )
    await producer.send_and_wait(topic, value=orjson.dumps(envelope), key=str(status).encode())
    EVENTS_FORWARDED.labels(channel="status").inc()


async def _publish(
    *,
    producer: AIOKafkaProducer,
    settings: Settings,
    channel: str,
    symbol: str,
    seq: int,
    payload: Any,
    is_final: bool,
    start_time: float,
) -> None:
    topic = _topic_for(channel, settings)
    event_ts = _event_timestamp(payload)
    dedup_key = _dedup_key(channel, symbol, payload)
    dedup_key_str = str(dedup_key)
    envelope = build_envelope(
        channel=channel,
        symbol=symbol,
        seq=seq,
        payload=payload,
        event_ts=to_iso(event_ts) if event_ts else None,
        is_final=is_final,
        source="alpaca",
        key=dedup_key_str,
    )
    key_bytes = f"{symbol}|{dedup_key_str}".encode()
    await producer.send_and_wait(topic, value=orjson.dumps(envelope), key=key_bytes)
    EVENTS_FORWARDED.labels(channel=channel).inc()
    PUBLISH_LATENCY.labels(channel=channel).observe(time.time() - start_time)


async def _handle_event(
    *,
    channel: str,
    symbol: str,
    payload: Any,
    caches: dict[str, DedupCache],
    producer: AIOKafkaProducer,
    settings: Settings,
    seq_counter,
    is_final: bool = False,
) -> None:
    start = time.time()
    EVENTS_RECEIVED.labels(channel=channel).inc()
    key = _dedup_key(channel, symbol, payload)
    cache = caches[channel]
    if not cache.seen(key, start):
        DEDUP_DROPPED.labels(channel=channel).inc()
        logger.debug("dropped duplicate", channel=channel, symbol=symbol, key=key)
        return
    seq = next(seq_counter[channel])
    await _publish(
        producer=producer,
        settings=settings,
        channel=channel,
        symbol=symbol,
        seq=seq,
        payload=payload,
        is_final=is_final,
        start_time=start,
    )


def _build_stream(settings: Settings) -> StockDataStream:
    return StockDataStream(
        api_key=settings.alpaca_api_key,
        secret_key=settings.alpaca_secret_key,
        feed=settings.alpaca_feed,
        url_override=settings.alpaca_stream_url,
    )


async def _run_stream(settings: Settings, producer: AIOKafkaProducer) -> None:
    caches = {
        "trades": DedupCache(settings.dedup_ttl_seconds, settings.dedup_max_keys),
        "quotes": DedupCache(settings.dedup_ttl_seconds, settings.dedup_max_keys),
        "bars": DedupCache(settings.dedup_ttl_seconds, settings.dedup_max_keys),
        "trade_updates": DedupCache(settings.dedup_ttl_seconds, settings.dedup_max_keys),
    }
    seq_counter = {
        "trades": count(1),
        "quotes": count(1),
        "bars": count(1),
        "trade_updates": count(1),
        "status": count(1),
    }

    stream = _build_stream(settings)
    symbols = _symbol_list(settings.symbols)

    async def handle_trade(trade):
        await _handle_event(
            channel="trades",
            symbol=str(getattr(trade, "symbol", "")),
            payload=trade,
            caches=caches,
            producer=producer,
            settings=settings,
            seq_counter=seq_counter,
            is_final=True,
        )

    async def handle_quote(quote):
        await _handle_event(
            channel="quotes",
            symbol=str(getattr(quote, "symbol", "")),
            payload=quote,
            caches=caches,
            producer=producer,
            settings=settings,
            seq_counter=seq_counter,
        )

    async def handle_bar(bar):
        is_final = bool(getattr(bar, "is_final", getattr(bar, "is_bartype_final", False)))
        await _handle_event(
            channel="bars",
            symbol=str(getattr(bar, "symbol", "")),
            payload=bar,
            caches=caches,
            producer=producer,
            settings=settings,
            seq_counter=seq_counter,
            is_final=is_final,
        )

    async def handle_trade_update(tu):
        await _handle_event(
            channel="trade_updates",
            symbol=str(getattr(tu, "symbol", "")),
            payload=tu,
            caches=caches,
            producer=producer,
            settings=settings,
            seq_counter=seq_counter,
        )

    stream.subscribe_trades(handle_trade, *symbols)
    stream.subscribe_quotes(handle_quote, *symbols)
    stream.subscribe_bars(handle_bar, *symbols)
    if settings.enable_trade_updates:
        stream.subscribe_trade_updates(handle_trade_update, *symbols)

    SUBSCRIPTION_READY.set(1)
    state = getattr(settings, "__state__", None)
    if isinstance(state, RuntimeState):
        state.subscribed = True
    await _send_status(
        producer,
        settings,
        seq=next(seq_counter["status"]),
        status="connected",
        detail={"symbols": symbols, "feed": settings.alpaca_feed},
    )

    try:
        await stream.run()
    finally:  # pragma: no cover - relies on network
        SUBSCRIPTION_READY.set(0)
        if isinstance(state, RuntimeState):
            state.subscribed = False
        await stream.stop()
        await _send_status(
            producer,
            settings,
            seq=next(seq_counter["status"]),
            status="disconnected",
        )


async def _create_producer(settings: Settings) -> AIOKafkaProducer:
    producer = AIOKafkaProducer(
        bootstrap_servers=settings.kafka_bootstrap_servers,
        security_protocol=settings.kafka_security_protocol,
        sasl_mechanism=settings.kafka_sasl_mechanism,
        sasl_plain_username=settings.kafka_username,
        sasl_plain_password=settings.kafka_password,
        acks="all",
        enable_idempotence=True,
        linger_ms=settings.producer_linger_ms,
        max_request_size=settings.producer_max_request_size,
        compression_type=settings.producer_compression,
        value_serializer=lambda v: v,
        key_serializer=lambda v: v,
        partitioner=_symbol_partitioner,
    )
    await producer.start()
    PRODUCER_READY.set(1)
    state = getattr(settings, "__state__", None)
    if isinstance(state, RuntimeState):
        state.producer_ready = True
    return producer


async def _run(settings: Settings) -> None:
    configure_logging(settings.log_level)
    logger.info("starting torghut forwarder", symbols=settings.symbols)

    state = RuntimeState()
    # attach to settings so helpers can see state without threading new args everywhere
    setattr(settings, "__state__", state)

    health = HealthServer(settings.metrics_host, settings.metrics_port, state)
    await health.start()

    producer = await _create_producer(settings)

    async def shutdown():
        logger.info("shutting down")
        SUBSCRIPTION_READY.set(0)
        PRODUCER_READY.set(0)
        state.producer_ready = False
        state.subscribed = False
        try:
            await producer.stop()
        finally:
            await health.stop()

    loop = asyncio.get_running_loop()
    for signame in ("SIGINT", "SIGTERM"):
        loop.add_signal_handler(getattr(signal, signame), lambda: asyncio.create_task(shutdown()))

    @retry(wait=wait_exponential(multiplier=settings.reconnect_initial, max=settings.reconnect_max), stop=stop_after_delay(settings.reconnect_max * 10))
    async def connect_and_stream():
        RECONNECTS.inc()
        await _run_stream(settings, producer)

    backoff = settings.reconnect_initial
    while True:
        try:
            await connect_and_stream()
            backoff = settings.reconnect_initial
        except RetryError as exc:  # pragma: no cover - network heavy
            logger.error("stream retry exhausted", error=str(exc))
            await _send_status(
                producer,
                settings,
                seq=0,
                status="failed",
                detail={"error": str(exc)},
            )
            await asyncio.sleep(settings.reconnect_max)
        except Exception as exc:  # pragma: no cover - network heavy
            logger.exception("stream crashed", error=str(exc))
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, settings.reconnect_max)


def main() -> None:  # pragma: no cover - thin wrapper
    settings = get_settings()
    asyncio.run(_run(settings))


if __name__ == "__main__":
    main()
