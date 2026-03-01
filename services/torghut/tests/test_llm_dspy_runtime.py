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
from app.trading.llm.dspy_programs.modules import LiveDSPyCommitteeProgram
from app.trading.llm.schema import (
    LLMDecisionContext,
    LLMPolicyContext,
    LLMReviewRequest,
    PortfolioSnapshot,
)
from app.trading.llm.dspy_programs.signatures import DSPyTradeReviewOutput


class TestLLMDSPyRuntime(TestCase):
    def _enable_live_runtime_gate(
        self,
        *,
        jangar_base_url: str | None = None,
        trading_mode: str = "live",
    ) -> dict[str, object]:
        original = {
            "trading_mode": settings.trading_mode,
            "llm_dspy_runtime_mode": settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": settings.llm_dspy_artifact_hash,
            "jangar_base_url": settings.jangar_base_url,
            "llm_allowed_models_raw": settings.llm_allowed_models_raw,
            "llm_rollout_stage": settings.llm_rollout_stage,
            "llm_evaluation_report": settings.llm_evaluation_report,
            "llm_effective_challenge_id": settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": settings.llm_shadow_completed_at,
            "llm_model_version_lock": settings.llm_model_version_lock,
        }
        settings.llm_allowed_models_raw = settings.llm_model
        settings.llm_rollout_stage = "stage3"
        settings.llm_evaluation_report = "ok"
        settings.llm_effective_challenge_id = "dspy-runtime-challenge"
        settings.llm_shadow_completed_at = "2026-03-01T00:00:00Z"
        settings.llm_model_version_lock = settings.llm_model
        settings.llm_dspy_runtime_mode = "active"
        settings.llm_dspy_artifact_hash = "a" * 64
        if jangar_base_url is not None:
            settings.jangar_base_url = jangar_base_url
        settings.trading_mode = trading_mode
        return original

    def _restore_live_runtime_gate(self, original: dict[str, object]) -> None:
        settings.trading_mode = cast(str, original["trading_mode"])
        settings.llm_dspy_runtime_mode = cast(
            str,
            original["llm_dspy_runtime_mode"],
        )
        settings.llm_dspy_artifact_hash = cast(
            str | None,
            original["llm_dspy_artifact_hash"],
        )
        settings.jangar_base_url = cast(str | None, original["jangar_base_url"])
        settings.llm_allowed_models_raw = cast(
            str | None,
            original["llm_allowed_models_raw"],
        )
        settings.llm_rollout_stage = cast(
            str | None,
            original["llm_rollout_stage"],
        )
        settings.llm_evaluation_report = cast(
            str | None,
            original["llm_evaluation_report"],
        )
        settings.llm_effective_challenge_id = cast(
            str | None,
            original["llm_effective_challenge_id"],
        )
        settings.llm_shadow_completed_at = cast(
            str | None,
            original["llm_shadow_completed_at"],
        )
        settings.llm_model_version_lock = cast(
            str | None,
            original["llm_model_version_lock"],
        )

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
            settings.jangar_base_url = "http://jangar.example/openai/v1"
            self.assertEqual(
                _resolve_dspy_api_base(),
                "http://jangar.example/openai/v1/chat/completions",
            )
            settings.jangar_base_url = "http://jangar.example/openai/v1/chat/completions"
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
            settings.jangar_base_url = "http://jangar.example/openai/v1/chat/completions"
            self.assertEqual(
                _resolve_dspy_api_base(),
                "http://jangar.example/openai/v1/chat/completions",
            )
            settings.jangar_base_url = "http://jangar.example/openai/v1?x=y"
            with self.assertRaises(DSPyRuntimeUnsupportedStateError):
                _resolve_dspy_api_base()
            settings.jangar_base_url = "http://jangar.example/foo"
            with self.assertRaises(DSPyRuntimeUnsupportedStateError):
                _resolve_dspy_api_base()
            settings.jangar_base_url = "http://jangar.example/openai/v1/chat/completions#frag"
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
                program.api_completion_url,
                "https://jangar.openai.local/openai/v1/chat/completions",
            )
            self.assertIsNone(program.api_base)
            self.assertEqual(program.api_key, "test-key")
            self.assertEqual(program.model_name, f"openai/{settings.llm_model}")
        finally:
            settings.jangar_base_url = original_base
            settings.jangar_api_key = original_api_key

    def test_active_runtime_review_uses_dspy_live_program(self) -> None:
        original_gate = self._enable_live_runtime_gate(
            jangar_base_url="https://jangar.openai.local/openai/v1"
        )
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
        expected_output = DSPyTradeReviewOutput.model_validate(
            {
                "verdict": "approve",
                "confidence": 0.88,
                "rationale": "dspy_live_approved",
                "requiredChecks": ["risk_engine"],
                "riskFlags": [],
                "uncertaintyBand": "low",
            }
        )

        fake_program = SimpleNamespace(run=lambda _payload: expected_output)

        try:
            with patch.object(runtime, "_load_manifest_from_db", return_value=manifest):
                with patch.object(
                    runtime, "_resolve_program", return_value=fake_program
                ):
                    response, metadata = runtime.review(self._request())

            self.assertEqual(response.verdict, "approve")
            self.assertEqual(metadata.executor, "dspy_live")
            self.assertEqual(metadata.artifact_source, "database")
            self.assertEqual(metadata.program_name, "trade-review-committee-v1")
        finally:
            self._restore_live_runtime_gate(original_gate)

    def test_active_runtime_blocks_when_live_gate_fails(self) -> None:
        original_gate = self._enable_live_runtime_gate(
            jangar_base_url="https://jangar.openai.local"
        )
        runtime = DSPyReviewRuntime(
            mode="active",
            artifact_hash="a" * 64,
            program_name="trade-review-committee-v1",
            signature_version="v1",
            timeout_seconds=8,
        )
        settings.llm_rollout_stage = "stage2"

        try:
            with self.assertRaises(DSPyRuntimeUnsupportedStateError) as exc:
                runtime.review(self._request())

            self.assertIn(
                "dspy_live_runtime_gate_blocked", str(exc.exception)
            )
            self.assertIn("dspy_live_runtime_gate_blocked:", str(exc.exception))
        finally:
            self._restore_live_runtime_gate(original_gate)

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
        original_gate = self._enable_live_runtime_gate(
            jangar_base_url="https://jangar.openai.local"
        )
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
        self._restore_live_runtime_gate(original_gate)

    def test_program_name_mismatch_is_blocking(self) -> None:
        original_gate = self._enable_live_runtime_gate(
            jangar_base_url="https://jangar.openai.local"
        )
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
        self._restore_live_runtime_gate(original_gate)

    def test_unknown_artifact_hash_is_rejected(self) -> None:
        original_gate = self._enable_live_runtime_gate(
            jangar_base_url="https://jangar.openai.local"
        )
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
        self._restore_live_runtime_gate(original_gate)

    def test_runtime_requires_artifact_hash(self) -> None:
        original_gate = self._enable_live_runtime_gate(
            jangar_base_url="https://jangar.openai.local"
        )
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
        self._restore_live_runtime_gate(original_gate)

    def test_active_runtime_rejects_heuristic_executor(self) -> None:
        original_gate = self._enable_live_runtime_gate(
            jangar_base_url="https://jangar.openai.local"
        )
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
        self._restore_live_runtime_gate(original_gate)

    def test_unknown_artifact_executor_is_blocking(self) -> None:
        original_gate = self._enable_live_runtime_gate(
            jangar_base_url="https://jangar.openai.local"
        )
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
            "dspy_artifact_executor_unknown",
            str(exc.exception),
        )
        self._restore_live_runtime_gate(original_gate)

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

        with patch(
            "app.db.SessionLocal", return_value=_FakeSessionContext(row)
        ), patch(
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
