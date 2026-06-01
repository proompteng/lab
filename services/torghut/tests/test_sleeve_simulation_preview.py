from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.replay_tape import (
    ReplayTapeManifest,
    build_source_query_digest,
    materialize_signal_tape,
)
from app.trading.discovery.sleeve_simulation_preview import (
    SLEEVE_SIMULATION_PREVIEW_PANEL_SCHEMA_VERSION,
    SLEEVE_SIMULATION_PREVIEW_ROW_SCHEMA_VERSION,
    build_sleeve_simulation_preview,
)
from app.trading.models import SignalEnvelope
from scripts import run_sleeve_simulation_preview


class TestSleeveSimulationPreview(TestCase):
    def test_build_preview_records_lineage_and_preserves_promotion_blockers(self) -> None:
        manifest = self._manifest()
        panel = build_sleeve_simulation_preview(
            specs=[
                self._candidate_spec("spec-a", ["NVDA"]),
                self._candidate_spec("spec-b", ["AAPL"]),
            ],
            rows=[
                self._signal("NVDA", "2026-05-26T13:30:00+00:00", 100.0),
                self._signal("NVDA", "2026-05-26T13:31:00+00:00", 101.0),
                self._signal("NVDA", "2026-05-26T13:32:00+00:00", 102.0),
                self._signal("AAPL", "2026-05-26T13:30:00+00:00", 200.0),
                self._signal("AAPL", "2026-05-26T13:31:00+00:00", 198.0),
                self._signal("AAPL", "2026-05-26T13:32:00+00:00", 197.0),
            ],
            replay_tape_manifest=manifest,
            preview_scores={"spec-a": 10.0, "spec-b": 5.0},
            top_k=1,
            backend_preference="cpu",
        )

        payload = panel.to_payload()
        self.assertEqual(
            payload["schema_version"],
            SLEEVE_SIMULATION_PREVIEW_PANEL_SCHEMA_VERSION,
        )
        self.assertFalse(payload["promotion_proof"])
        self.assertIn("exact_replay_required", payload["blockers"])
        self.assertIn("runtime_ledger_proof_required", payload["blockers"])
        self.assertIn("live_paper_parity_required", payload["blockers"])
        self.assertEqual(payload["replay_tape"]["content_sha256"], "tape-digest")
        self.assertEqual(payload["selected_candidate_spec_ids"], ["spec-a"])

        first_row = payload["rows"][0]
        self.assertEqual(
            first_row["schema_version"], SLEEVE_SIMULATION_PREVIEW_ROW_SCHEMA_VERSION
        )
        self.assertEqual(first_row["candidate_spec_id"], "spec-a")
        self.assertTrue(first_row["selected"])
        self.assertEqual(first_row["selection_reason"], "sleeve_simulation_preview_selected")
        self.assertEqual(first_row["path_count"], 1)
        self.assertEqual(first_row["step_count"], 2)
        self.assertGreater(float(first_row["mean_final_pnl_bps"]), 0.0)
        self.assertEqual(
            first_row["simulation"]["backend_context"]["selected_backend"],
            "numpy",
        )
        self.assertFalse(first_row["simulation"]["backend_context"]["promotion_proof"])

    def test_build_preview_marks_specs_without_replay_paths_not_selected(self) -> None:
        panel = build_sleeve_simulation_preview(
            specs=[self._candidate_spec("spec-missing", ["MSFT"])],
            rows=[
                self._signal("NVDA", "2026-05-26T13:30:00+00:00", 100.0),
                self._signal("NVDA", "2026-05-26T13:31:00+00:00", 101.0),
            ],
            replay_tape_manifest=self._manifest(),
            top_k=1,
            backend_preference="cpu",
        )

        payload = panel.to_payload()
        self.assertEqual(payload["selected_candidate_spec_ids"], [])
        self.assertEqual(payload["rows"][0]["path_count"], 0)
        self.assertEqual(
            payload["rows"][0]["selection_reason"],
            "insufficient_replay_tape_returns",
        )

    def test_cli_writes_manifest_and_rows(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            tape_path = root / "replay-tape.jsonl"
            manifest_path = root / "replay-tape.jsonl.manifest.json"
            manifest = materialize_signal_tape(
                rows=[
                    self._signal("NVDA", "2026-05-26T13:30:00+00:00", 100.0),
                    self._signal("NVDA", "2026-05-26T13:31:00+00:00", 101.0),
                    self._signal("NVDA", "2026-05-26T13:32:00+00:00", 102.0),
                ],
                tape_path=tape_path,
                manifest_path=manifest_path,
                dataset_snapshot_ref="fixture",
                symbols=("NVDA",),
                start_date=date(2026, 5, 26),
                end_date=date(2026, 5, 26),
                source_query_digest="source-digest",
            )
            specs_path = root / "selected-candidate-specs.jsonl"
            specs_path.write_text(
                json.dumps(
                    self._candidate_spec("spec-a", ["NVDA"]).to_payload(),
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )
            output_dir = root / "out"

            exit_code = run_sleeve_simulation_preview.main(
                [
                    "--candidate-specs",
                    str(specs_path),
                    "--replay-tape-path",
                    str(tape_path),
                    "--replay-tape-manifest",
                    str(manifest_path),
                    "--output-dir",
                    str(output_dir),
                    "--backend",
                    "cpu",
                ]
            )

            self.assertEqual(exit_code, 0)
            manifest_payload = (
                output_dir / "sleeve-simulation-preview-manifest.json"
            ).read_text(encoding="utf-8")
            self.assertIn(manifest.content_sha256, manifest_payload)
            self.assertTrue((output_dir / "sleeve-simulation-preview-rows.jsonl").exists())

    def _candidate_spec(
        self, candidate_spec_id: str, symbols: list[str]
    ) -> CandidateSpec:
        return CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id=candidate_spec_id,
            hypothesis_id=f"hyp-{candidate_spec_id}",
            family_template_id="intraday_tsmom_v2",
            candidate_kind="sleeve",
            runtime_family="intraday_tsmom_consistent",
            runtime_strategy_name="intraday-tsmom-profit-v3",
            feature_contract={"expected_direction": "positive"},
            parameter_space={},
            strategy_overrides={
                "universe_symbols": symbols,
                "params": {
                    "long_stop_loss_bps": "100",
                    "long_trailing_stop_drawdown_bps": "20",
                },
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={},
        )

    def _manifest(self) -> ReplayTapeManifest:
        now = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        return ReplayTapeManifest(
            schema_version="torghut.replay-tape-manifest.v1",
            dataset_snapshot_ref="fixture",
            symbols=("NVDA", "AAPL"),
            row_symbols=("NVDA", "AAPL"),
            start_date=date(2026, 5, 26),
            end_date=date(2026, 5, 26),
            start_ts=now,
            end_ts=now,
            min_event_ts=now,
            max_event_ts=now,
            trading_day_count=1,
            row_count=6,
            source_query_digest=build_source_query_digest({"fixture": "source"}),
            content_sha256="tape-digest",
            artifact_refs={"tape_path": "fixture.jsonl"},
            source_table_versions={},
            created_at=now,
        )

    def _signal(self, symbol: str, event_ts: str, price: float) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime.fromisoformat(event_ts),
            symbol=symbol,
            timeframe="1Sec",
            source="ta",
            payload={"price": price},
        )
