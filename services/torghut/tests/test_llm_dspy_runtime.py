from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, cast
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.trading.llm.dspy_programs.runtime import (
    DSPyArtifactManifest,
    DSPyReviewRuntime,
    DSPyRuntimeUnsupportedStateError,
    _resolve_dspy_completion_url,
    _resolve_dspy_api_base,
)
from app.trading.llm.schema import (
    LLMDecisionContext,
    LLMPolicyContext,
    LLMReviewRequest,
    PortfolioSnapshot,
)
from app.trading.llm.dspy_programs.signatures import DSPyTradeReviewOutput


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
        original_base = settings.jangar_base_url
        settings.jangar_base_url = "https://jangar.local/"
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
        settings.jangar_base_url = original_base

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
        original_base = settings.jangar_base_url
        settings.jangar_base_url = "https://jangar.local/"
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
        settings.jangar_base_url = original_base

    def test_unknown_artifact_executor_is_blocking(self) -> None:
        original_base = settings.jangar_base_url
        settings.jangar_base_url = "https://jangar.local/"
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

        self.assertIn(
            "dspy_active_mode_requires_dspy_live_executor",
            str(exc.exception),
        )
        settings.jangar_base_url = original_base

    def test_missing_artifact_executor_field_is_rejected(self) -> None:
        artifact_hash = "a" * 64

        class _FakeResult:
            def __init__(self, row: SimpleNamespace) -> None:
                self._row = row

            def scalars(self) -> "_FakeResult":
                return self

            def first(self) -> SimpleNamespace:
                return self._row

        class _FakeSession:
            def __init__(self, row: SimpleNamespace) -> None:
                self._row = row

            def execute(self, _query: Any) -> _FakeResult:
                return _FakeResult(self._row)

        class _FakeSessionContext:
            def __init__(self, row: SimpleNamespace) -> None:
                self._row = row

            def __enter__(self) -> _FakeSession:
                return _FakeSession(self._row)

            def __exit__(self, exc_type: object, exc: object, tb: object) -> bool | None:
                return None

        runtime = DSPyReviewRuntime(
            mode="active",
            artifact_hash=artifact_hash,
            program_name="trade-review-committee-v1",
            signature_version="v1",
            timeout_seconds=8,
        )
        row = SimpleNamespace(
            artifact_uri="http://artifact.local",
            reproducibility_hash="repro",
            optimizer="opt",
            dataset_hash="dataset",
            compiled_prompt_hash="compiled",
            signature_version="trade_review:v1",
            program_name="trade-review-committee-v1",
            gate_compatibility="pass",
            metadata_json={},
        )

        with patch("app.trading.llm.dspy_programs.runtime.SessionLocal", return_value=_FakeSessionContext(row)), patch(
            "app.trading.llm.dspy_programs.runtime.hash_payload",
            return_value=artifact_hash,
        ):
            with self.assertRaises(DSPyRuntimeUnsupportedStateError) as exc:
                runtime._load_manifest_from_db(artifact_hash)

        self.assertIn("dspy_artifact_executor_missing", str(exc.exception))

    def test_active_readiness_rejects_heuristic_executor(self) -> None:
        original_base = settings.jangar_base_url
        settings.jangar_base_url = "https://jangar.local/"
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

        with patch.object(runtime, "_load_manifest_from_db", return_value=manifest):
            is_ready, reasons = runtime.evaluate_live_readiness()

        self.assertFalse(is_ready)
        self.assertIn(
            "dspy_active_mode_requires_dspy_live_executor",
            reasons,
        )
        settings.jangar_base_url = original_base

    def test_active_readiness_blocks_invalid_jangar_base_url(self) -> None:
        original_base = settings.jangar_base_url
        settings.jangar_base_url = "https://jangar.example/openai/v1?x=1"
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

        try:
            with patch.object(runtime, "_load_manifest_from_db", return_value=manifest):
                is_ready, reasons = runtime.evaluate_live_readiness()

            self.assertFalse(is_ready)
            self.assertIn("dspy_jangar_base_url_invalid_path", reasons)
        finally:
            settings.jangar_base_url = original_base

    def test_active_readiness_blocks_jangar_base_url_fragment(self) -> None:
        original_base = settings.jangar_base_url
        settings.jangar_base_url = "https://jangar.example/openai/v1#x"
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

        try:
            with patch.object(runtime, "_load_manifest_from_db", return_value=manifest):
                is_ready, reasons = runtime.evaluate_live_readiness()

            self.assertFalse(is_ready)
            self.assertIn("dspy_jangar_base_url_invalid_path", reasons)
        finally:
            settings.jangar_base_url = original_base

    def test_active_readiness_blocks_unsupported_jangar_base_scheme(self) -> None:
        original_base = settings.jangar_base_url
        settings.jangar_base_url = "ftp://jangar.example/"
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

        try:
            with patch.object(runtime, "_load_manifest_from_db", return_value=manifest):
                is_ready, reasons = runtime.evaluate_live_readiness()

            self.assertFalse(is_ready)
            self.assertIn("dspy_jangar_base_url_invalid_scheme", reasons)
        finally:
            settings.jangar_base_url = original_base

    def test_active_readiness_accepts_dspy_live_executor(self) -> None:
        original_base = settings.jangar_base_url
        settings.jangar_base_url = "https://jangar.local/"
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

        with patch.object(runtime, "_load_manifest_from_db", return_value=manifest):
            is_ready, reasons = runtime.evaluate_live_readiness()

        self.assertTrue(is_ready)
        self.assertEqual(reasons, ())
        settings.jangar_base_url = original_base

    def test_resolve_dspy_api_base_uses_jangar_openai_endpoint(self) -> None:
        original_base = settings.jangar_base_url
        try:
            settings.jangar_base_url = "https://jangar.example/"
            runtime = DSPyReviewRuntime(
                mode="active",
                artifact_hash="a" * 64,
                program_name="trade-review-committee-v1",
                signature_version="v1",
                timeout_seconds=8,
            )

            with patch.object(
                runtime, "_load_manifest_from_db", return_value=DSPyArtifactManifest(
                    artifact_hash="a" * 64,
                    program_name="trade-review-committee-v1",
                    signature_version="v1",
                    executor="dspy_live",
                    compiled_prompt={},
                    source="database",
                )
            ):
                _, reasons = runtime.evaluate_live_readiness()
                self.assertEqual(reasons, ())

            self.assertEqual(
                _resolve_dspy_api_base(), "https://jangar.example/openai/v1"
            )
            self.assertEqual(
                _resolve_dspy_completion_url(),
                "https://jangar.example/openai/v1/chat/completions",
            )
            settings.jangar_base_url = "https://jangar.example/openai/v1/"
            self.assertEqual(
                _resolve_dspy_api_base(),
                "https://jangar.example/openai/v1",
            )
            settings.jangar_base_url = "https://jangar.example/openai/v1/chat/completions"
            self.assertEqual(
                _resolve_dspy_api_base(),
                "https://jangar.example/openai/v1",
            )
            self.assertEqual(
                _resolve_dspy_completion_url(),
                "https://jangar.example/openai/v1/chat/completions",
            )
        finally:
            settings.jangar_base_url = original_base

    def test_evaluate_live_readiness_blocks_without_jangar_api_base(self) -> None:
        original_base = settings.jangar_base_url
        settings.jangar_base_url = None
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
        try:
            with patch.object(runtime, "_load_manifest_from_db", return_value=manifest):
                is_ready, reasons = runtime.evaluate_live_readiness()

            self.assertFalse(is_ready)
            self.assertIn("dspy_jangar_base_url_missing", reasons)
        finally:
            settings.jangar_base_url = original_base

    def test_live_runtime_uses_jangar_openai_base_in_program_init(self) -> None:
        original_base = settings.jangar_base_url
        settings.jangar_base_url = "https://jangar.example/"
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

        init_calls: dict[str, str] = {}

        class _ProbeDSPyProgram:
            def __init__(
                self,
                model_name: str,
                api_base: str | None = None,
                api_key: str | None = None,
            ) -> None:
                init_calls["model_name"] = model_name
                init_calls["api_base"] = api_base or ""
                init_calls["api_key"] = api_key or ""

            def run(self, _payload: Any) -> DSPyTradeReviewOutput:
                return DSPyTradeReviewOutput.model_validate(
                    {
                        "verdict": "approve",
                        "confidence": 0.91,
                        "rationale": "dspy_live_committee",
                        "requiredChecks": ["risk_engine"],
                        "riskFlags": [],
                    }
                )

        try:
            with patch.object(runtime, "_load_manifest_from_db", return_value=manifest), patch(
                "app.trading.llm.dspy_programs.runtime.LiveDSPyCommitteeProgram",
                _ProbeDSPyProgram,
            ):
                response, _metadata = runtime.review(self._request())

            self.assertEqual(response.verdict, "approve")
            self.assertEqual(
                init_calls.get("api_base"), "https://jangar.example/openai/v1"
            )
            self.assertEqual(init_calls.get("model_name"), "openai/gpt-5.3-codex-spark")
        finally:
            settings.jangar_base_url = original_base
