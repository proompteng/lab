"""OpenAI client wrapper for LLM reviews."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, cast

from openai import OpenAI
from openai.types.chat import ChatCompletionMessageParam


@dataclass
class LLMClientResponse:
    content: str
    usage: Optional[dict[str, int]]


class LLMClient:
    """Thin wrapper around the OpenAI client to keep it mockable."""

    def __init__(self, model: str, timeout_seconds: int) -> None:
        self._client = OpenAI(timeout=timeout_seconds)
        self._model = model

    def request_review(
        self,
        messages: list[ChatCompletionMessageParam],
        temperature: float,
        max_tokens: int,
    ) -> LLMClientResponse:
        response = self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )

        content = response.choices[0].message.content or ""
        usage = cast(dict[str, int], response.usage.model_dump()) if response.usage else None

        return LLMClientResponse(content=content, usage=usage)
