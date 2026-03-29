"""Kafka helpers for the options lane."""

from __future__ import annotations

from collections.abc import Callable
import threading
from datetime import datetime
from typing import Any, Protocol, cast

from kafka import KafkaProducer  # pyright: ignore[reportMissingTypeStubs]

from .json import dump_json


class _KafkaProducerProtocol(Protocol):
    def send(self, topic: str, value: dict[str, object] | None = None, key: str | None = None) -> object: ...

    def flush(self, timeout: float | None = None) -> None: ...

    def close(self, timeout: float | None = None, _null_logger: bool = False) -> None: ...


def _serialize_key(key: str) -> bytes:
    return key.encode("utf-8")


def _serialize_value(value: dict[str, object]) -> bytes:
    return dump_json(value).encode("utf-8")


class SequenceGenerator:
    """Thread-safe monotonic local sequence generator."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value = 0

    def next(self) -> int:
        with self._lock:
            self._value += 1
            return self._value


class OptionsKafkaProducer:
    """Thin JSON Kafka producer for raw options topics."""

    def __init__(
        self,
        *,
        bootstrap_servers: str,
        security_protocol: str,
        sasl_mechanism: str,
        sasl_username: str,
        sasl_password: str,
        linger_ms: int,
        batch_size: int,
        request_timeout_ms: int,
    ) -> None:
        producer_kwargs: dict[str, Any] = {
            "bootstrap_servers": bootstrap_servers,
            "acks": "all",
            "compression_type": "lz4",
            "linger_ms": linger_ms,
            "batch_size": batch_size,
            "request_timeout_ms": request_timeout_ms,
            "key_serializer": cast(Callable[[str], bytes], _serialize_key),
            "value_serializer": cast(Callable[[dict[str, object]], bytes], _serialize_value),
        }
        if sasl_password:
            producer_kwargs.update(
                {
                    "security_protocol": security_protocol,
                    "sasl_mechanism": sasl_mechanism,
                    "sasl_plain_username": sasl_username,
                    "sasl_plain_password": sasl_password,
                }
            )
        self._producer = cast(_KafkaProducerProtocol, KafkaProducer(**producer_kwargs))

    def send(self, topic: str, key: str, payload: dict[str, object]) -> None:
        self._producer.send(topic, key=key, value=payload)

    def flush(self) -> None:
        self._producer.flush()

    def close(self) -> None:
        self._producer.flush()
        self._producer.close()


def build_envelope(
    *,
    feed: str,
    channel: str,
    symbol: str,
    seq: int,
    payload: dict[str, Any],
    event_ts: datetime,
    ingest_ts: datetime,
    source: str,
    is_final: bool = True,
    version: int = 1,
    window: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a JSON envelope compatible with the Kotlin Envelope serializer."""

    envelope: dict[str, Any] = {
        "ingestTs": ingest_ts.isoformat(),
        "eventTs": event_ts.isoformat(),
        "feed": feed,
        "channel": channel,
        "symbol": symbol,
        "seq": seq,
        "payload": payload,
        "isFinal": is_final,
        "source": source,
        "version": version,
    }
    if window is not None:
        envelope["window"] = window
    return envelope
