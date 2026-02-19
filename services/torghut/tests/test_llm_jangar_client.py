import io
import json
import unittest
from unittest.mock import patch

from app.config import settings
from app.trading.llm.client import LLMClient, LLMClientResponse
from app.trading.llm.client import _parse_jangar_decision_sse, _parse_jangar_sse


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


class TestJangarDecisionSseParsing(unittest.TestCase):
    def test_parses_final_content_and_usage(self) -> None:
        final_payload = json.dumps(
            {
                "run_id": "run-1",
                "payload": {
                    "llm_response": {
                        "content": '{"verdict":"approve"}',
                        "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
                    }
                },
            }
        )
        stream = io.BytesIO(
            f"""
event: decision.accepted
data: {{"run_id":"run-1","payload":{{"request_id":"req-1"}}}}

event: decision.final
data: {final_payload}

""".encode("utf-8")
        )

        content, usage = _parse_jangar_decision_sse(stream)
        self.assertEqual(content, '{"verdict":"approve"}')
        self.assertEqual(usage, {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18})

    def test_raises_on_error_event(self) -> None:
        stream = io.BytesIO(
            b"""
event: decision.error
data: {"payload":{"code":"run_failed","message":"boom"}}

"""
        )

        with self.assertRaises(RuntimeError):
            _parse_jangar_decision_sse(stream)


class TestJangarFallbackChain(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_provider = settings.llm_provider
        self._orig_trading_mode = settings.trading_mode
        self._orig_bespoke_enabled = settings.llm_jangar_bespoke_decision_enabled
        self._orig_bespoke_retries = settings.llm_jangar_bespoke_max_retries

    def tearDown(self) -> None:
        settings.llm_provider = self._orig_provider
        settings.trading_mode = self._orig_trading_mode
        settings.llm_jangar_bespoke_decision_enabled = self._orig_bespoke_enabled
        settings.llm_jangar_bespoke_max_retries = self._orig_bespoke_retries

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

    def test_retries_bespoke_with_same_request_id(self) -> None:
        settings.llm_provider = "jangar"
        settings.trading_mode = "paper"
        settings.llm_jangar_bespoke_decision_enabled = True
        settings.llm_jangar_bespoke_max_retries = 1

        client = LLMClient(model="gpt-test", timeout_seconds=1)
        calls: list[dict[str, object]] = []

        def fake_once(
            self: LLMClient,
            *,
            request_id: str,
            messages: list[dict[str, object]],
            temperature: float,
            max_tokens: int,
        ) -> LLMClientResponse:
            calls.append(
                {
                    "request_id": request_id,
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                }
            )
            if len(calls) == 1:
                raise TimeoutError("timed out")
            return LLMClientResponse(
                content=json.dumps({"verdict": "approve", "confidence": 0.9, "rationale": "ok", "risk_flags": []}),
                usage=None,
            )

        with patch.object(LLMClient, "_request_review_via_jangar_bespoke_once", new=fake_once):
            response = client.request_review(messages=[], temperature=0.2, max_tokens=10)

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["request_id"], calls[1]["request_id"])
        self.assertIn('"verdict": "approve"', response.content)

    def test_raises_when_all_providers_fail_in_paper_mode(self) -> None:
        settings.llm_provider = "jangar"
        settings.trading_mode = "paper"

        client = LLMClient(model="gpt-test", timeout_seconds=1)

        with patch.object(LLMClient, "_request_review_via_jangar", side_effect=RuntimeError("nope")):
            with patch.object(LLMClient, "_request_review_via_self_hosted", side_effect=RuntimeError("nope2")):
                with self.assertRaises(RuntimeError):
                    client.request_review(messages=[], temperature=0.2, max_tokens=10)

    def test_raises_when_all_providers_fail_in_live_mode(self) -> None:
        settings.llm_provider = "jangar"
        settings.trading_mode = "live"

        client = LLMClient(model="gpt-test", timeout_seconds=1)

        with patch.object(LLMClient, "_request_review_via_jangar", side_effect=RuntimeError("nope")):
            with patch.object(LLMClient, "_request_review_via_self_hosted", side_effect=RuntimeError("nope2")):
                with self.assertRaises(RuntimeError):
                    client.request_review(messages=[], temperature=0.2, max_tokens=10)


if __name__ == "__main__":
    unittest.main()
