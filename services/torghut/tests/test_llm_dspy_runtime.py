from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import cast
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.trading.llm.dspy_programs.runtime import (
    DSPyArtifactManifest,
    DSPyReviewRuntime,
    DSPyRuntimeUnsupportedStateError,
    _resolve_dspy_api_base,
)
from app.trading.llm.dspy_programs.modules import LiveDSPyCommitteeProgram
from app.trading.llm.schema import (
    LLMDecisionContext,
    LLMPolicyContext,
    LLMReviewRequest,
    PortfolioSnapshot,
)


class TestLLMDSPyRuntime(TestCase):
    def _request(self) -> LLMReviewRequest:
        return LLMReviewRequest(
            decision=LLMDecisionContext(
                strategy_id="demo",
                symbol="AAPL",
                action="buy",
                qty=Decimal("1"),
                order_type="market",
                time_in_force="day",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                rationale="demo",
                params={},
            ),
            portfolio=PortfolioSnapshot(
                equity=Decimal("10000"),
                cash=Decimal("10000"),
                buying_power=Decimal("10000"),
                total_exposure=Decimal("0"),
                exposure_by_symbol={},
                positions=[],
            ),
            market=None,
            market_context=None,
            recent_decisions=[],
            account={"equity": "10000", "cash": "10000", "buying_power": "10000"},
            positions=[],
            policy=LLMPolicyContext(
                adjustment_allowed=True,
                min_qty_multiplier=Decimal("0.5"),
                max_qty_multiplier=Decimal("1.25"),
                allowed_order_types=["market", "limit"],
            ),
            trading_mode="paper",
            prompt_version="test",
        )

    def test_bootstrap_artifact_executes_and_emits_metadata(self) -> None:
        runtime = DSPyReviewRuntime(
            mode="shadow",
            artifact_hash=DSPyReviewRuntime.bootstrap_artifact_hash(),
            program_name="trade-review-committee-v1",
            signature_version="v1",
            timeout_seconds=8,
        )

        response, metadata = runtime.review(self._request())

        self.assertIn(
            response.verdict, {"approve", "veto", "adjust", "abstain", "escalate"}
        )
        self.assertEqual(metadata.artifact_source, "bootstrap")
        self.assertEqual(metadata.executor, "heuristic")

    def test_resolves_live_jangar_completion_endpoint(self) -> None:
        original_base = settings.jangar_base_url
        try:
            settings.jangar_base_url = "http://jangar.example"

            self.assertEqual(
                _resolve_dspy_api_base(),
                "http://jangar.example/openai/v1/chat/completions",
            )
            settings.jangar_base_url = "http://jangar.example/"
            self.assertEqual(
                _resolve_dspy_api_base(),
                "http://jangar.example/openai/v1/chat/completions",
            )
        finally:
            settings.jangar_base_url = original_base

    def test_resolve_dspy_api_base_requires_jangar_base_url(self) -> None:
        original_base = settings.jangar_base_url
        try:
            settings.jangar_base_url = None
            with self.assertRaises(DSPyRuntimeUnsupportedStateError):
                _resolve_dspy_api_base()
        finally:
            settings.jangar_base_url = original_base

    def test_live_artifact_resolves_dspy_live_program(self) -> None:
        original_base = settings.jangar_base_url
        original_api_key = settings.jangar_api_key
        try:
            settings.jangar_base_url = "https://jangar.openai.local"
            settings.jangar_api_key = "test-key"
            runtime = DSPyReviewRuntime(
                mode="active",
                artifact_hash="a" * 64,
                program_name="trade-review-committee-v1",
                signature_version="v1",
                timeout_seconds=8,
            )
            manifest = DSPyArtifactManifest(
                artifact_hash="a" * 64,
                program_name="trade-review-committee-v1",
                signature_version="v1",
                executor="dspy_live",
                compiled_prompt={},
                source="database",
            )

            program = runtime._resolve_program(manifest)
            self.assertIsInstance(program, LiveDSPyCommitteeProgram)
            self.assertEqual(
                program.api_base,
                "https://jangar.openai.local/openai/v1/chat/completions",
            )
            self.assertEqual(program.api_key, "test-key")
            self.assertEqual(program.model_name, f"openai/{settings.llm_model}")
        finally:
            settings.jangar_base_url = original_base
            settings.jangar_api_key = original_api_key

    def test_disabled_runtime_mode_is_blocking(self) -> None:
        runtime = DSPyReviewRuntime(
            mode="disabled",
            artifact_hash="a" * 64,
            program_name="trade-review-committee-v1",
            signature_version="v1",
            timeout_seconds=8,
        )

        with self.assertRaises(DSPyRuntimeUnsupportedStateError) as exc:
            runtime.review(self._request())

        self.assertIn("dspy_runtime_disabled", str(exc.exception))

    def test_active_runtime_rejects_bootstrap_artifact_hash(self) -> None:
        runtime = DSPyReviewRuntime(
            mode="active",
            artifact_hash=DSPyReviewRuntime.bootstrap_artifact_hash(),
            program_name="trade-review-committee-v1",
            signature_version="v1",
            timeout_seconds=8,
        )

        with self.assertRaises(DSPyRuntimeUnsupportedStateError) as exc:
            runtime.review(self._request())

        self.assertIn("dspy_bootstrap_artifact_forbidden", str(exc.exception))

    def test_program_name_mismatch_is_blocking(self) -> None:
        runtime = DSPyReviewRuntime(
            mode="shadow",
            artifact_hash=DSPyReviewRuntime.bootstrap_artifact_hash(),
            program_name="trade-review-committee-v2",
            signature_version="v1",
            timeout_seconds=8,
        )

        with self.assertRaises(DSPyRuntimeUnsupportedStateError) as exc:
            runtime.review(self._request())

        self.assertIn("dspy_program_name_mismatch", str(exc.exception))

    def test_unknown_artifact_hash_is_rejected(self) -> None:
        runtime = DSPyReviewRuntime(
            mode="active",
            artifact_hash="a" * 64,
            program_name="trade-review-committee-v1",
            signature_version="v1",
            timeout_seconds=8,
        )

        with patch.object(runtime, "_load_manifest_from_db", return_value=None):
            with self.assertRaises(DSPyRuntimeUnsupportedStateError) as exc:
                runtime.review(self._request())

        self.assertIn("dspy_artifact_manifest_not_found", str(exc.exception))

    def test_runtime_requires_artifact_hash(self) -> None:
        runtime = DSPyReviewRuntime(
            mode="active",
            artifact_hash=None,
            program_name="trade-review-committee-v1",
            signature_version="v1",
            timeout_seconds=8,
        )

        with self.assertRaises(DSPyRuntimeUnsupportedStateError) as exc:
            runtime.review(self._request())

        self.assertIn("dspy_artifact_hash_missing", str(exc.exception))

    def test_active_runtime_rejects_heuristic_executor(self) -> None:
        runtime = DSPyReviewRuntime(
            mode="active",
            artifact_hash="a" * 64,
            program_name="trade-review-committee-v1",
            signature_version="v1",
            timeout_seconds=8,
        )
        manifest = DSPyArtifactManifest(
            artifact_hash="a" * 64,
            program_name="trade-review-committee-v1",
            signature_version="v1",
            executor="heuristic",
            compiled_prompt={},
            source="database",
        )

        with patch.object(
            runtime, "_load_manifest_from_db", return_value=manifest
        ):
            with self.assertRaises(DSPyRuntimeUnsupportedStateError) as exc:
                runtime.review(self._request())

        self.assertIn(
            "dspy_active_mode_requires_dspy_live_executor",
            str(exc.exception),
        )

    def test_unknown_artifact_executor_is_blocking(self) -> None:
        runtime = DSPyReviewRuntime(
            mode="active",
            artifact_hash="a" * 64,
            program_name="trade-review-committee-v1",
            signature_version="v1",
            timeout_seconds=8,
        )
        manifest = cast(
            DSPyArtifactManifest,
            SimpleNamespace(
                artifact_hash="a" * 64,
                program_name="trade-review-committee-v1",
                signature_version="v1",
                executor="scaffold",
                compiled_prompt={},
                source="database",
            ),
        )

        with patch.object(runtime, "_load_manifest_from_db", return_value=manifest):
            with self.assertRaises(DSPyRuntimeUnsupportedStateError) as exc:
                runtime.review(self._request())

        self.assertIn("dspy_artifact_executor_unknown", str(exc.exception))
