from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app.trading.llm.dspy_programs.modules import (
    LiveDSPyCommitteeProgram,
    _coerce_dspy_api_base,
)


class _FakeLM:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs


class _FakePredictor:
    def __call__(self, **_kwargs) -> SimpleNamespace:
        raise RuntimeError("should not execute predictor in this test")


class _StaticPredictor:
    def __init__(self, response_json: object) -> None:
        self.response_json = response_json

    def __call__(self, **_kwargs) -> SimpleNamespace:
        return SimpleNamespace(response_json=self.response_json)


class TestDSPyTransportHardening(TestCase):
    def test_coerces_chat_completion_url_to_llm_base(self) -> None:
        self.assertEqual(
            _coerce_dspy_api_base(
                api_base="https://jangar.example/openai/v1/chat/completions",
                api_completion_url=None,
            ),
            "https://jangar.example/openai/v1",
        )

    def test_live_program_rejects_empty_dspy_api_base(self) -> None:
        fake_dspy = SimpleNamespace(
            Signature=type("Signature", (), {}),
            LM=_FakeLM,
            InputField=lambda *_args, **_kwargs: None,
            OutputField=lambda *_args, **_kwargs: None,
            Predict=lambda *_args, **_kwargs: _FakePredictor(),
        )

        with patch("app.trading.llm.dspy_programs.modules.dspy", fake_dspy):
            program = LiveDSPyCommitteeProgram(
                model_name="openai/gpt-test",
                api_base=None,
            )
            with self.assertRaises(RuntimeError):
                program._ensure_predictor()

    def test_live_program_coerces_api_base(self) -> None:
        captured: dict[str, dict[str, object]] = {}

        class _TrackingLM(_FakeLM):
            def __init__(self, **kwargs) -> None:
                super().__init__(**kwargs)
                captured["lm_kwargs"] = kwargs

        fake_dspy = SimpleNamespace(
            Signature=type("Signature", (), {}),
            LM=_TrackingLM,
            InputField=lambda *_args, **_kwargs: None,
            OutputField=lambda *_args, **_kwargs: None,
            Predict=lambda *_args, **_kwargs: _FakePredictor(),
        )

        with patch("app.trading.llm.dspy_programs.modules.dspy", fake_dspy):
            program = LiveDSPyCommitteeProgram(
                model_name="openai/gpt-test",
                api_base="http://jangar.openai.local/openai/v1/chat/completions",
            )
            program._ensure_predictor()

        self.assertEqual(
            captured["lm_kwargs"]["api_base"],
            "http://jangar.openai.local/openai/v1",
        )

    def test_live_program_prefers_api_completion_url(self) -> None:
        captured: dict[str, dict[str, object]] = {}

        class _TrackingLM(_FakeLM):
            def __init__(self, **kwargs) -> None:
                super().__init__(**kwargs)
                captured["lm_kwargs"] = kwargs

        fake_dspy = SimpleNamespace(
            Signature=type("Signature", (), {}),
            LM=_TrackingLM,
            InputField=lambda *_args, **_kwargs: None,
            OutputField=lambda *_args, **_kwargs: None,
            Predict=lambda *_args, **_kwargs: _FakePredictor(),
            context=None,
            configure=lambda **_kwargs: None,
        )

        with patch("app.trading.llm.dspy_programs.modules.dspy", fake_dspy):
            program = LiveDSPyCommitteeProgram(
                model_name="openai/gpt-test",
                api_base="http://jangar.openai.local/openai/v1",
                api_completion_url="https://jangar.openai.local/openai/v1/chat/completions",
            )
            program._ensure_predictor()

        self.assertEqual(
            captured["lm_kwargs"]["api_base"],
            "https://jangar.openai.local/openai/v1",
        )

    def test_live_program_rejects_non_dict_response_json(self) -> None:
        request_payload = SimpleNamespace(request_json='{"foo":"bar"}')
        fake_dspy = SimpleNamespace(
            Signature=type("Signature", (), {}),
            LM=_FakeLM,
            InputField=lambda *_args, **_kwargs: None,
            OutputField=lambda *_args, **_kwargs: None,
            Predict=lambda *_args, **_kwargs: _StaticPredictor(response_json=["unexpected"]),
            context=None,
            configure=lambda **_kwargs: None,
        )

        with patch("app.trading.llm.dspy_programs.modules.dspy", fake_dspy):
            program = LiveDSPyCommitteeProgram(
                model_name="openai/gpt-test",
                api_base="https://jangar.openai.local/openai/v1",
            )
            with self.assertRaises(RuntimeError):
                program.run(payload=request_payload)

    def test_live_program_rejects_invalid_dspy_api_base_path(self) -> None:
        fake_dspy = SimpleNamespace(
            Signature=type("Signature", (), {}),
            LM=_FakeLM,
            InputField=lambda *_args, **_kwargs: None,
            OutputField=lambda *_args, **_kwargs: None,
            Predict=lambda *_args, **_kwargs: _FakePredictor(),
        )

        with patch("app.trading.llm.dspy_programs.modules.dspy", fake_dspy):
            program = LiveDSPyCommitteeProgram(
                model_name="openai/gpt-test",
                api_base="http://jangar.openai.local/openai/v1/foo",
            )
            with self.assertRaises(RuntimeError):
                program._ensure_predictor()

    def test_coerce_accepts_base_or_completion_paths(self) -> None:
        self.assertEqual(
            _coerce_dspy_api_base(
                api_base="https://jangar.openai.local",
                api_completion_url=None,
            ),
            "https://jangar.openai.local",
        )
        self.assertEqual(
            _coerce_dspy_api_base(
                api_base="https://jangar.openai.local/openai/v1",
                api_completion_url=None,
            ),
            "https://jangar.openai.local/openai/v1",
        )
        self.assertEqual(
            _coerce_dspy_api_base(
                api_base="https://jangar.openai.local/openai/v1/chat/completions",
                api_completion_url=None,
            ),
            "https://jangar.openai.local/openai/v1",
        )
