"""Thread-safe operational state for the options archive worker."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import threading

from .archive_repository import ArchiveCheckpoint


@dataclass(frozen=True, slots=True)
class ArchiveStateUpdate:
    phase: str
    observed_at: datetime
    lease_acquired: bool | None = None
    checkpoint: ArchiveCheckpoint | None = None
    error_code: str | None = None
    error_detail: str | None = None
    completed: bool = False


class ArchiveRuntimeState:
    """Operational state exposed without gating live catalog readiness."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.phase = "starting"
        self.lease_acquired = False
        self.active_shard: str | None = None
        self.cursor_present = False
        self.page_count = 0
        self.seen_count = 0
        self.retry_count = 0
        self.last_success_ts: str | None = None
        self.last_heartbeat_ts: str | None = None
        self.last_error_code: str | None = None
        self.last_error_detail: str | None = None

    def update(self, change: ArchiveStateUpdate) -> None:
        with self._lock:
            self.phase = change.phase
            self.last_heartbeat_ts = change.observed_at.isoformat()
            if change.lease_acquired is not None:
                self.lease_acquired = change.lease_acquired
            if change.checkpoint is not None:
                self.active_shard = change.checkpoint.shard.key
                self.cursor_present = change.checkpoint.cursor is not None
                self.page_count = change.checkpoint.page_count
                self.seen_count = change.checkpoint.seen_count
                self.retry_count = change.checkpoint.retry_count
                if change.checkpoint.last_success_at is not None:
                    self.last_success_ts = change.checkpoint.last_success_at.isoformat()
            if change.completed:
                self.last_success_ts = change.observed_at.isoformat()
            self.last_error_code = change.error_code
            self.last_error_detail = change.error_detail

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            return {
                "phase": self.phase,
                "lease_acquired": self.lease_acquired,
                "active_shard": self.active_shard,
                "cursor_present": self.cursor_present,
                "page_count": self.page_count,
                "seen_count": self.seen_count,
                "retry_count": self.retry_count,
                "last_success_ts": self.last_success_ts,
                "last_heartbeat_ts": self.last_heartbeat_ts,
                "last_error_code": self.last_error_code,
                "last_error_detail": self.last_error_detail,
            }


def archive_is_ready(snapshot: dict[str, object]) -> bool:
    """Return whether the archive owns its fence and is making safe progress."""

    return (
        snapshot.get("lease_acquired") is True
        and snapshot.get("phase") in {"running", "finalizing", "complete"}
        and snapshot.get("last_error_code") is None
    )
