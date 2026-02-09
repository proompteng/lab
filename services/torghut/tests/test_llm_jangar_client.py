import io
import unittest

from app.trading.llm.client import _parse_jangar_sse


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


if __name__ == "__main__":
    unittest.main()

