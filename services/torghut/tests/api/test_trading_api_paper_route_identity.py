from __future__ import annotations

from app.api import proofs as proofs_api

from tests.api.trading_api_support import (
    Strategy,
    TradingApiTestCaseBase,
    datetime,
    timezone,
)


class TestTradingApiPaperRouteIdentity(TradingApiTestCaseBase):
    def test_configured_paper_collection_proofs_have_identity_fields(self) -> None:
        original_mode = proofs_api.settings.trading_mode
        original_static_symbols_raw = proofs_api.settings.trading_static_symbols_raw
        try:
            proofs_api.settings.trading_mode = "live"
            proofs_api.settings.trading_static_symbols_raw = "AAPL,NVDA"
            with self.session_local() as session:
                session.add(
                    Strategy(
                        name="identity-collector",
                        description="identity collector",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL", "NVDA"],
                    )
                )
                session.commit()
                live_submission_gate = (
                    proofs_api._with_configured_paper_collection_targets(
                        {},
                        simple_lane_status={
                            "paper_route_probe_enabled": True,
                            "paper_route_probe_allow_live_mode": True,
                            "paper_route_probe_max_notional": "100",
                        },
                        session=session,
                    )
                )
                payload = proofs_api.build_proofs_payload(
                    session,
                    live_submission_gate=live_submission_gate,
                    route_reacquisition_book={},
                    generated_at=datetime(2026, 6, 18, 12, tzinfo=timezone.utc),
                    kind="runtime_window",
                    limit=20,
                    window="next",
                    full_audit=False,
                    target_account_audit_available=True,
                )
        finally:
            proofs_api.settings.trading_mode = original_mode
            proofs_api.settings.trading_static_symbols_raw = original_static_symbols_raw

        matching_proofs = [
            proof
            for proof in payload["proofs"]
            if proof["identity"]["candidate_id"] == "configured:identity-collector"
        ]
        self.assertEqual(len(matching_proofs), 1)
        proof = matching_proofs[0]
        identity = proof["identity"]
        self.assertEqual(
            identity["hypothesis_id"],
            "configured-paper-collection:identity-collector",
        )
        self.assertEqual(identity["strategy_name"], "identity-collector")
        self.assertEqual(identity["runtime_strategy_name"], "identity-collector")
        self.assertNotIn("missing-hypothesis", proof["proof_id"])
        self.assertTrue(proof["window"]["start"])
        self.assertTrue(proof["window"]["end"])
