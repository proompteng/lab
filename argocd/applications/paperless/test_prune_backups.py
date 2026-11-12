"""Prove only owned, expired snapshots are eligible for cleanup."""

import datetime as dt
import unittest

from prune_backups import eligible

NOW = dt.datetime(2026, 11, 12, tzinfo=dt.UTC)


def backup(
    days_old: int,
    *,
    cluster: str = "paperless-db",
    schedule: str = "paperless-db-daily",
    phase: str = "completed",
) -> dict:
    return {
        "metadata": {
            "uid": f"snapshot-{days_old}",
            "name": f"paperless-{days_old}",
            "creationTimestamp": (NOW - dt.timedelta(days=days_old))
            .isoformat()
            .replace("+00:00", "Z"),
            "labels": {
                "cnpg.io/cluster": cluster,
                "cnpg.io/scheduled-backup": schedule,
            },
        },
        "status": {"phase": phase},
    }


class BackupRetentionTests(unittest.TestCase):
    def test_preserves_latest_two_and_prunes_expired(self) -> None:
        entries = [backup(day) for day in (1, 7, 31, 45, 60)]
        self.assertEqual(
            [entry["metadata"]["name"] for entry in eligible(entries, NOW)],
            ["paperless-31", "paperless-45", "paperless-60"],
        )

    def test_preserves_last_two_even_when_old(self) -> None:
        self.assertEqual(eligible([backup(90), backup(80)], NOW), [])

    def test_only_deletes_successful_backups_from_our_schedule(self) -> None:
        entries = [
            backup(1),
            backup(2),
            backup(40, cluster="another-db"),
            backup(40, schedule="manual"),
            backup(40, phase="failed"),
        ]
        self.assertEqual(eligible(entries, NOW), [])


if __name__ == "__main__":
    unittest.main()
