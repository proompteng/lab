"""Typed, bounded contracts shared by Torghut diagnostics notebooks."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal, Mapping

import pandas as pd

QualityState = Literal["ok", "expected_idle", "unavailable", "invalid"]
FlowLane = Literal["equities", "options", "hyperliquid"]
WindowKind = Literal["minutes", "days", "sessions"]
Record = dict[str, object]
Records = tuple[Record, ...]

MAX_PROJECTED_ROWS = 100_000
MAX_FIGURE_POINTS = 10_000
PREFERRED_FIGURE_POINTS = 5_000


def _empty_datasets() -> dict[str, Records]:
    return {}


@dataclass(frozen=True, slots=True)
class Window:
    """A validated diagnostic window with hard production bounds."""

    kind: WindowKind
    value: int
    as_of: datetime | None = None

    def __post_init__(self) -> None:
        if self.value < 1:
            raise ValueError("window value must be positive")
        maximum = {"minutes": 360, "days": 180, "sessions": 5}[self.kind]
        if self.value > maximum:
            raise ValueError(f"{self.kind} window exceeds hard maximum of {maximum}")
        if self.as_of is not None and self.as_of.tzinfo is None:
            raise ValueError("window as_of must be timezone-aware")

    @classmethod
    def minutes(cls, value: int, *, as_of: datetime | None = None) -> Window:
        return cls("minutes", value, as_of)

    @classmethod
    def days(cls, value: int, *, as_of: datetime | None = None) -> Window:
        return cls("days", value, as_of)

    @classmethod
    def sessions(cls, value: int = 1, *, as_of: datetime | None = None) -> Window:
        return cls("sessions", value, as_of)

    def end(self, *, now: datetime | None = None) -> datetime:
        observed = self.as_of or now or datetime.now(timezone.utc)
        return observed.astimezone(timezone.utc)

    def start(self, *, now: datetime | None = None) -> datetime:
        end = self.end(now=now)
        if self.kind == "minutes":
            return end - timedelta(minutes=self.value)
        if self.kind == "days":
            return end - timedelta(days=self.value)
        # Session selection happens server-side. Five calendar days per session
        # safely bounds weekends and exchange holidays without scanning raw data.
        return end - timedelta(days=self.value * 5)

    def to_metadata(self, *, now: datetime | None = None) -> Record:
        return {
            "kind": self.kind,
            "value": self.value,
            "start": self.start(now=now).isoformat(),
            "end": self.end(now=now).isoformat(),
        }


@dataclass(frozen=True, slots=True)
class QueryResult:
    """Rows returned by one bounded source query."""

    records: Records
    watermark: datetime | None = None
    truncated: bool = False


@dataclass(frozen=True, slots=True)
class Snapshot:
    """Provenance-bearing result consumed by a diagnostics notebook."""

    captured_at: datetime
    effective_window: Mapping[str, object]
    source_watermark: datetime | None
    row_count: int
    query_identifier: str
    image_revision: str
    git_revision: str
    truncated: bool
    quality: QualityState
    datasets: Mapping[str, Records] = field(default_factory=_empty_datasets)
    messages: tuple[str, ...] = ()

    def frame(self, name: str) -> pd.DataFrame:
        """Return one named dataset without hiding missing-data states."""

        if name not in self.datasets:
            raise KeyError(f"snapshot has no dataset named {name!r}")
        return pd.DataFrame.from_records(self.datasets[name])

    def provenance(self) -> pd.DataFrame:
        """Render compact provenance suitable for the top of every notebook."""

        return pd.DataFrame.from_records(
            [
                {
                    "captured_at_utc": self.captured_at.isoformat(),
                    "effective_window": dict(self.effective_window),
                    "source_watermark_utc": (
                        self.source_watermark.isoformat()
                        if self.source_watermark
                        else None
                    ),
                    "row_count": self.row_count,
                    "query_identifier": self.query_identifier,
                    "image_revision": self.image_revision,
                    "git_revision": self.git_revision,
                    "truncated": self.truncated,
                    "quality": self.quality,
                    "messages": list(self.messages),
                }
            ]
        )


def parse_utc(value: object) -> datetime | None:
    """Parse common PostgreSQL, ClickHouse, and HTTP timestamp values as UTC."""

    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        try:
            parsed = datetime.strptime(normalized, "%Y-%m-%d %H:%M:%S.%f")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def max_watermark(*results: QueryResult) -> datetime | None:
    values = [result.watermark for result in results if result.watermark is not None]
    return max(values) if values else None


def guard_figure_points(frame: pd.DataFrame, *, label: str) -> pd.DataFrame:
    """Fail closed before a figure can exceed the explicit point budget."""

    if len(frame.index) > MAX_FIGURE_POINTS:
        raise ValueError(
            f"{label} has {len(frame.index)} points; aggregate below {MAX_FIGURE_POINTS} before plotting"
        )
    return frame
