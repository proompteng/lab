from __future__ import annotations

import time
from collections import OrderedDict
from typing import Hashable, Optional


class DedupCache:
    """Simple TTL-based deduplication cache.

    Maintains insertion order to prune old keys while ensuring quick membership checks.
    """

    def __init__(self, ttl_seconds: int = 900, max_keys: int = 50_000):
        self.ttl_seconds = ttl_seconds
        self.max_keys = max_keys
        self._store: "OrderedDict[Hashable, float]" = OrderedDict()

    def _evict_expired(self, now: Optional[float] = None) -> None:
        if now is None:
            now = time.time()
        ttl_boundary = now - self.ttl_seconds
        while self._store:
            _, ts = next(iter(self._store.items()))
            if ts < ttl_boundary:
                self._store.popitem(last=False)
            else:
                break

    def seen(self, key: Hashable, now: Optional[float] = None) -> bool:
        """Returns True if key is new, False if duplicate."""
        if now is None:
            now = time.time()
        self._evict_expired(now)
        if key in self._store:
            return False
        self._store[key] = now
        while len(self._store) > self.max_keys:
            self._store.popitem(last=False)
        return True

    def __len__(self) -> int:  # pragma: no cover - trivial
        return len(self._store)
