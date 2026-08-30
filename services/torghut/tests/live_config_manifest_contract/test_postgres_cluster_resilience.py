from __future__ import annotations

from typing import Mapping, cast
from unittest import TestCase

from .support import load_yaml_mapping


class PostgresClusterResilienceManifestTests(TestCase):
    def setUp(self) -> None:
        self.cluster = load_yaml_mapping(
            "argocd/applications/torghut/postgres-cluster.yaml"
        )
        self.cluster_spec = cast(Mapping[str, object], self.cluster["spec"])

    def test_cluster_has_one_cross_host_amd64_standby(self) -> None:
        self.assertEqual(self.cluster_spec["instances"], 2)
        self.assertEqual(self.cluster_spec["primaryUpdateStrategy"], "unsupervised")
        self.assertEqual(self.cluster_spec["primaryUpdateMethod"], "switchover")

        affinity = cast(Mapping[str, object], self.cluster_spec["affinity"])
        self.assertNotIn("nodeSelector", affinity)
        self.assertEqual(affinity["podAntiAffinityType"], "required")
        self.assertEqual(affinity["topologyKey"], "kubernetes.io/hostname")
        self.assertEqual(
            affinity["nodeAffinity"],
            {
                "requiredDuringSchedulingIgnoredDuringExecution": {
                    "nodeSelectorTerms": [
                        {
                            "matchExpressions": [
                                {
                                    "key": "kubernetes.io/arch",
                                    "operator": "In",
                                    "values": ["amd64"],
                                }
                            ]
                        }
                    ]
                }
            },
        )

    def test_cluster_resources_are_bounded(self) -> None:
        self.assertEqual(
            self.cluster_spec["resources"],
            {
                "requests": {"cpu": "500m", "memory": "1Gi"},
                "limits": {"cpu": "4", "memory": "8Gi"},
            },
        )

    def test_continuous_backup_prefers_the_standby(self) -> None:
        backup = cast(Mapping[str, object], self.cluster_spec["backup"])
        object_store = cast(Mapping[str, object], backup["barmanObjectStore"])
        wal = cast(Mapping[str, object], object_store["wal"])

        self.assertEqual(backup["target"], "prefer-standby")
        self.assertEqual(backup["retentionPolicy"], "14d")
        self.assertEqual(object_store["destinationPath"], "s3://cnpg-torghut")
        self.assertEqual(object_store["serverName"], "torghut-db-live")
        self.assertEqual(wal["maxParallel"], 8)

        schedule = load_yaml_mapping(
            "argocd/applications/torghut/postgres-scheduled-backup.yaml"
        )
        schedule_spec = cast(Mapping[str, object], schedule["spec"])
        self.assertEqual(schedule_spec["schedule"], "0 0 2 * * *")
        self.assertEqual(schedule_spec["method"], "barmanObjectStore")
        self.assertEqual(schedule_spec["backupOwnerReference"], "self")
        self.assertEqual(schedule_spec["cluster"], {"name": "torghut-db"})
