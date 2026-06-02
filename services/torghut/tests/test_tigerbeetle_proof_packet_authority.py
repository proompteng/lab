from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from scripts import assemble_runtime_ledger_proof_packet as packet
from tests.test_assemble_runtime_ledger_proof_packet import (
    _completion,
    _paper_route_evidence,
    _runtime_import,
    _status,
    _tigerbeetle_ledger_status,
)


class TestTigerBeetleProofPacketAuthority(TestCase):
    def test_tigerbeetle_only_refs_do_not_create_promotion_authority(self) -> None:
        runtime_import = _runtime_import(authoritative=False)
        import_summary = runtime_import["imports"][0]["summary"]
        materialized_target = import_summary["runtime_materialization_target"]
        materialized_target["tigerbeetle"] = {
            "schema_version": "torghut.tigerbeetle-runtime-ledger-proof-refs.v1",
            "cluster_ids": [2001],
            "account_count": 2,
            "transfer_count": 1,
            "account_ids": ["1001", "1002"],
            "account_keys": ["evidence_control:paper:usd", "runtime_ledger:paper:run"],
            "transfer_ids": ["340282366920938463463374607431768211"],
            "source_refs": [
                "postgres:tigerbeetle_account_refs:account-ref-1",
                "postgres:tigerbeetle_transfer_refs:transfer-ref-1",
            ],
            "runtime_ledger_buckets": [
                {
                    "runtime_ledger_bucket_id": "runtime-ledger-bucket-1",
                    "transfer_ids": ["340282366920938463463374607431768211"],
                }
            ],
        }

        result = packet.build_runtime_ledger_proof_packet(
            _status(tigerbeetle_ledger=_tigerbeetle_ledger_status()),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"], result)
        self.assertFalse(result["promotion_authority"]["allowed"], result)
        self.assertFalse(result["capital_promotion_allowed"], result)
        self.assertIn(
            "runtime_window_import_runtime_ledger_bucket_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        tigerbeetle_check = result["checks"]["tigerbeetle_runtime_pnl_authority_refs"]
        self.assertTrue(tigerbeetle_check["passed"], tigerbeetle_check)
        self.assertTrue(tigerbeetle_check["observed"]["claimed"])
