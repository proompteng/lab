from __future__ import annotations

from torghut_forwarder.dedup import DedupCache


def test_dedup_allows_first_and_blocks_second():
    cache = DedupCache(ttl_seconds=100, max_keys=10)
    assert cache.seen("abc", now=0.0) is True
    assert cache.seen("abc", now=1.0) is False


def test_dedup_expires_after_ttl():
    cache = DedupCache(ttl_seconds=5, max_keys=10)
    assert cache.seen("abc", now=0.0)
    assert cache.seen("abc", now=3.0) is False
    assert cache.seen("abc", now=6.0) is True


def test_dedup_enforces_max_keys():
    cache = DedupCache(ttl_seconds=1000, max_keys=2)
    cache.seen("a", now=0.0)
    cache.seen("b", now=0.0)
    cache.seen("c", now=0.0)
    assert len(cache) == 2
    assert cache.seen("a", now=1.0) is True  # evicted oldest
