import io
import unittest
from unittest.mock import patch

from app.config import settings
from app.trading.llm.client import LLMClient, LLMClientResponse
from app.trading.llm.client import (
    _parse_jangar_sse,
    _resolve_dspy_jangar_completion_url,
)


class TestJangarSseParsing(unittest.TestCase):
    def test_parses_content_and_usage(self) -> None:
        stream = io.BytesIO(
            b"""
data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":"{\\n"},"index":0,"finish_reason":null}]}

data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"content":"  \\"verdict\\": \\"approve\\",\\n"},"index":0,"finish_reason":null}]}

data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"content":"  \\"confidence\\": 0.9,\\n"},"index":0,"finish_reason":null}]}

data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"content":"  \\"rationale\\": \\"ok\\",\\n"},"index":0,"finish_reason":null}]}

data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"content":"  \\"risk_flags\\": []\\n"},"index":0,"finish_reason":null}]}

data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"content":"}"},"index":0,"finish_reason":null}]}

data: {"id":"x","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}

data: [DONE]

"""
        )

        content, usage = _parse_jangar_sse(stream)
        self.assertIn('"verdict": "approve"', content)
        self.assertEqual(usage, {"prompt_tokens": 12, "completion_tokens": 34, "total_tokens": 46})

    def test_raises_on_error_frame(self) -> None:
        stream = io.BytesIO(
            b"""
data: {"error":{"message":"nope","type":"request_failed","code":"upstream"}}

data: [DONE]

"""
        )

        with self.assertRaises(RuntimeError):
            _parse_jangar_sse(stream)

    def test_times_out_when_deadline_exceeded(self) -> None:
        stream = io.BytesIO(b"data: {\"id\":\"x\"}\n")

        with self.assertRaises(TimeoutError):
            _parse_jangar_sse(stream, timeout_seconds=0)

class TestJangarFallbackChain(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_provider = settings.llm_provider
        self._orig_trading_mode = settings.trading_mode

    def tearDown(self) -> None:
        settings.llm_provider = self._orig_provider
        settings.trading_mode = self._orig_trading_mode

    def test_falls_back_to_self_hosted_when_jangar_fails(self) -> None:
        settings.llm_provider = "jangar"
        settings.trading_mode = "paper"

        client = LLMClient(model="gpt-test", timeout_seconds=1)
        expected = LLMClientResponse(content='{"verdict":"approve","confidence":1,"rationale":"ok","risk_flags":[]}', usage=None)

        with patch.object(LLMClient, "_request_review_via_jangar", side_effect=RuntimeError("nope")) as primary:
            with patch.object(LLMClient, "_request_review_via_self_hosted", return_value=expected) as fallback:
                response = client.request_review(messages=[], temperature=0.2, max_tokens=10)

        self.assertTrue(primary.called)
        self.assertTrue(fallback.called)
        self.assertEqual(response.content, expected.content)

    def test_raises_when_all_providers_fail_in_paper_mode(self) -> None:
        settings.llm_provider = "jangar"
        settings.trading_mode = "paper"

        client = LLMClient(model="gpt-test", timeout_seconds=1)

        with patch.object(LLMClient, "_request_review_via_jangar", side_effect=RuntimeError("nope")):
            with patch.object(LLMClient, "_request_review_via_self_hosted", side_effect=RuntimeError("nope2")):
                with self.assertRaises(RuntimeError):
                    client.request_review(messages=[], temperature=0.2, max_tokens=10)

    def test_does_not_fallback_to_self_hosted_in_live_mode_on_jangar_failure(
        self,
    ) -> None:
        settings.llm_provider = "jangar"
        settings.trading_mode = "live"

        client = LLMClient(model="gpt-test", timeout_seconds=1)

        with patch.object(
            LLMClient,
            "_request_review_via_jangar",
            side_effect=RuntimeError("nope"),
        ) as primary_exc:
            with patch.object(
                LLMClient, "_request_review_via_self_hosted", side_effect=RuntimeError("nope2")
            ) as fallback_exc:
                with self.assertRaises(RuntimeError):
                    client.request_review(messages=[], temperature=0.2, max_tokens=10)
        self.assertTrue(primary_exc.called)
        self.assertFalse(fallback_exc.called)


class TestJangarRequestHeaders(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_provider = settings.llm_provider
        self._orig_jangar_base_url = settings.jangar_base_url
        self._orig_jangar_api_key = settings.jangar_api_key

    def tearDown(self) -> None:
        settings.llm_provider = self._orig_provider
        settings.jangar_base_url = self._orig_jangar_base_url
        settings.jangar_api_key = self._orig_jangar_api_key

    def test_completion_request_sends_trade_execution_client_header(self) -> None:
        settings.llm_provider = "jangar"
        settings.jangar_base_url = "http://jangar"
        settings.jangar_api_key = "jangar-token"

        captured_headers: dict[str, str] = {}

        class _FakeResponse:
            status = 200

            def __enter__(self) -> "_FakeResponse":
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

            def read(self) -> bytes:
                return b""

        def _fake_urlopen(request, timeout=0):  # type: ignore[no-untyped-def]
            nonlocal captured_headers
            captured_headers = {name.lower(): value for name, value in request.header_items()}
            return _FakeResponse()

        client = LLMClient(model="gpt-test", timeout_seconds=1)

        with patch("app.trading.llm.client.urlopen", side_effect=_fake_urlopen):
            with patch(
                "app.trading.llm.client._parse_jangar_sse",
                return_value=('{"verdict":"approve","confidence":1,"rationale":"ok","risk_flags":[]}', None),
            ):
                response = client._request_review_via_jangar(messages=[], temperature=0.2, max_tokens=16)

        self.assertIn('"verdict":"approve"', response.content)
        self.assertEqual(captured_headers.get("x-trade-execution"), "torghut")
        self.assertEqual(captured_headers.get("authorization"), "Bearer jangar-token")


class TestJangarCompletionEndpointResolution(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_provider = settings.llm_provider
        self._orig_base_url = settings.jangar_base_url
        self._orig_api_key = settings.jangar_api_key

    def tearDown(self) -> None:
        settings.llm_provider = self._orig_provider
        settings.jangar_base_url = self._orig_base_url
        settings.jangar_api_key = self._orig_api_key

    def test_resolves_dspy_jangar_completion_url(self) -> None:
        settings.llm_provider = "jangar"

        settings.jangar_base_url = "http://jangar.example"
        self.assertEqual(
            _resolve_dspy_jangar_completion_url(),
            "http://jangar.example/openai/v1/chat/completions",
        )
        settings.jangar_base_url = "http://jangar.example/"
        self.assertEqual(
            _resolve_dspy_jangar_completion_url(),
            "http://jangar.example/openai/v1/chat/completions",
        )
        settings.jangar_base_url = "http://jangar.example/openai/v1"
        self.assertEqual(
            _resolve_dspy_jangar_completion_url(),
            "http://jangar.example/openai/v1/chat/completions",
        )
        settings.jangar_base_url = "http://jangar.example/openai/v1/chat/completions"
        self.assertEqual(
            _resolve_dspy_jangar_completion_url(),
            "http://jangar.example/openai/v1/chat/completions",
        )

        settings.jangar_base_url = "http://jangar.example/openai/v1?x=1"
        with self.assertRaises(RuntimeError):
            _resolve_dspy_jangar_completion_url()

    def test_request_review_posts_to_normalized_jangar_completion_url(self) -> None:
        settings.llm_provider = "jangar"
        settings.jangar_base_url = "http://jangar.example/openai/v1/chat/completions"
        captured_url: dict[str, str] = {}

        class _FakeResponse:
            status = 200

            def __enter__(self) -> "_FakeResponse":
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

            def read(self) -> bytes:
                return b""

        def _fake_urlopen(request, timeout=0):  # type: ignore[no-untyped-def]
            captured_url["value"] = request.full_url
            return _FakeResponse()

        client = LLMClient(model="gpt-test", timeout_seconds=1)
        with patch("app.trading.llm.client.urlopen", side_effect=_fake_urlopen):
            with patch(
                "app.trading.llm.client._parse_jangar_sse",
                return_value=(
                    '{"verdict":"approve","confidence":1,"rationale":"ok","risk_flags":[]}',
                    None,
                ),
            ):
                response = client._request_review_via_jangar(messages=[], temperature=0.2, max_tokens=16)

        self.assertIn('"verdict":"approve"', response.content)
        self.assertEqual(
            captured_url["value"],
            "http://jangar.example/openai/v1/chat/completions",
        )


if __name__ == "__main__":
    unittest.main()
