import importlib.util
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "neighbor_cache", Path(__file__).with_name("verify-neighbor-cache.py")
)
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class NeighborCacheTest(unittest.TestCase):
    def setUp(self):
        self.sample = {
            "boot_id": "same-boot",
            "thresholds": [4096, 8192, 16384],
            "entries": 1071,
            "table_fulls": 20,
            "unresolved_discards": 3,
            "forced_gc_runs": 25,
        }

    def test_entries_are_not_summed_across_cpus(self):
        stats = cache.parse_stats(
            "entries table_fulls unresolved_discards forced_gc_runs\n"
            "0000042f 00000002 00000003 00000004\n"
            "0000042f 00000005 00000006 00000007\n"
        )
        self.assertEqual(stats["entries"], 1071)
        self.assertEqual(stats["table_fulls"], 7)
        self.assertEqual(stats["unresolved_discards"], 9)

    def test_incomplete_telemetry_is_rejected(self):
        with self.assertRaises(ValueError):
            cache.parse_stats("entries table_fulls\n00000001\n")

    def test_historical_overflow_does_not_fail_recovery(self):
        self.assertEqual(cache.check(self.sample, self.sample)["failures"], [])

    def test_new_overflow_and_old_limits_fail(self):
        changed = {**self.sample, "thresholds": [128, 512, 1024], "table_fulls": 21}
        self.assertEqual(len(cache.check(self.sample, changed)["failures"]), 2)

    def test_reboot_or_counter_reset_cannot_pass(self):
        for change in ({"boot_id": "new-boot"}, {"table_fulls": 0}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                cache.check(self.sample, {**self.sample, **change})


if __name__ == "__main__":
    unittest.main()
