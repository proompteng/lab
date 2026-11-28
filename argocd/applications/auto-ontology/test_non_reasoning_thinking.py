"""Unit tests for non-reasoning-thinking.patch against Auto Ontology v1.3.0 llm_invoke."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import requests
from requests.structures import CaseInsensitiveDict

PATCH_PATH = Path(__file__).with_name("non-reasoning-thinking.patch")


def _build_v130_llm_invoke_fixture() -> str:
    """Exact v1.3.0 lines around the patched hunks in auto_ontology/utils/llm_invoke.py."""
    header = """# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES.
# All rights reserved.
# SPDX-License-Identifier: Apache-2.0

\"\"\"LLM client construction and structured-output invocation wrappers.\"\"\"

import contextlib
import logging
import os
import random
import threading
import time
import weakref
from typing import Iterator, Type, TypeVar

import requests as _requests
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, ConfigDict, ValidationError, model_validator

from auto_ontology.utils.model_config import resolve

logger = logging.getLogger(__name__)
LLM_INVOKE_TIMEOUT_S = int(os.environ.get("LLM_INVOKE_TIMEOUT_S", "120"))
"""
    header_lines = header.splitlines()
    # Pad lines 25..178 so hunk line numbers match upstream v1.3.0 verbatim.
    pad_count = 178 - len(header_lines)
    assert pad_count > 0
    padding = ["# fixture padding"] * pad_count

    tail = """def _is_retryable(e: Exception) -> bool:
    \"\"\"Whether *e* signals a transient, retryable server condition.\"\"\"
    return any(tok in str(e) for tok in _RETRYABLE_TOKENS) or (
        type(e).__name__ in _RETRYABLE_EXCEPTION_TYPES
    )


class _TimeoutSession(_requests.Session):
    \"\"\"requests.Session that enforces a default timeout on every request.\"\"\"

    def __init__(self, timeout: float = LLM_INVOKE_TIMEOUT_S, **kwargs):
        super().__init__(**kwargs)
        self._default_timeout = timeout

    def request(self, method, url, **kwargs):
        kwargs.setdefault("timeout", self._default_timeout)
        return super().request(method, url, **kwargs)


T = TypeVar("T", bound=BaseModel)

# Main (reasoning) model triplet. Each field falls back to DEFAULT_MODELS_<field>
# (and the API key additionally to the legacy NVIDIA_API_KEY) when unset.
_BASE_URL = resolve("REASONING", "ENDPOINT")
_MODEL_NAME = resolve("REASONING", "MODEL")
_API_KEY = resolve("REASONING", "API_KEY")

# Non-reasoning model. Kept fully separate (key/endpoint/model) so it can point at
# a different endpoint than the main model (e.g. inference vs integrate API). Each
# field falls back to DEFAULT_MODELS_<field> when unset.
_NON_REASONING_BASE_URL = resolve("NON_REASONING", "ENDPOINT")
_NON_REASONING_MODEL_NAME = resolve("NON_REASONING", "MODEL")
_NON_REASONING_API_KEY = resolve("NON_REASONING", "API_KEY")


def _build_client(
    *,
    model: str,
    api_key: str,
    base_url: str,
    temperature: float,
    max_tokens: int,
) -> BaseChatModel:
    \"\"\"Build a chat client for the given model/endpoint.

    OpenAI-family models (``openai/``, ``azure/``, ``aws/`` prefixes) go through
    ``ChatOpenAI``, which supports structured output. Everything else uses
    ``ChatNVIDIA``.
    \"\"\"
    if model.startswith(("openai/", "azure/", "aws/")):
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=model,
            api_key=api_key,
            base_url=base_url,
            # temperature omitted: gpt-5.x/o-series reject any explicit value and
            # only allow the server default (1). Unset => langchain sends no
            # temperature field, so the provider default applies.
            # temperature=temperature,
            max_tokens=max_tokens,
            timeout=LLM_INVOKE_TIMEOUT_S,
            max_retries=0,
        )

    from langchain_nvidia_ai_endpoints import ChatNVIDIA

    client = ChatNVIDIA(
        model=model,
        api_key=api_key,
        base_url=base_url,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    client._client.get_session_fn = lambda: _TimeoutSession(LLM_INVOKE_TIMEOUT_S)
    return client


def get_llm_client(
    *,
    model: str | None = None,
    temperature: float = 0.0,
    max_tokens: int = 8192,
) -> BaseChatModel:
    \"\"\"Create an LLM client for the main reasoning model.

    Parameters
    ----------
    model : str | None
        Override the default ``REASONING_MODEL`` env var for this client.
    \"\"\"
    if not _API_KEY:
        raise EnvironmentError("REASONING_API_KEY is not set")

    return _build_client(
        model=model or _MODEL_NAME,
        api_key=_API_KEY,
        base_url=_BASE_URL,
        temperature=temperature,
        max_tokens=max_tokens,
    )


def get_non_reasoning_llm_client(
    *,
    model: str | None = None,
    temperature: float = 0.0,
    max_tokens: int = 8192,
) -> BaseChatModel:
    \"\"\"Create an LLM client for the non-reasoning model.

    Uses ``NON_REASONING_API_KEY`` / ``NON_REASONING_ENDPOINT`` /
    ``NON_REASONING_MODEL`` so it can target a different endpoint than the
    main agent model.

    Parameters
    ----------
    model : str | None
        Override the default ``NON_REASONING_MODEL`` env var for this client.
    \"\"\"
    if not _NON_REASONING_API_KEY:
        raise EnvironmentError("NON_REASONING_API_KEY is not set")

    client = _build_client(
        model=model or _NON_REASONING_MODEL_NAME,
        api_key=_NON_REASONING_API_KEY,
        base_url=_NON_REASONING_BASE_URL,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    _remember_non_reasoning(client)
    return client


def _remember_non_reasoning(client: object) -> None:
    pass
"""
    return "\n".join(header_lines + padding) + "\n" + tail


class _FakeBaseChatModel:
    pass


class _FakeChatNVIDIA(_FakeBaseChatModel):
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self._client = types.SimpleNamespace(get_session_fn=None)


def _load_patched_llm_invoke():
    """Apply non-reasoning-thinking.patch to the v1.3.0 fixture and import it."""
    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "llm_invoke.py"
        target.write_text(_build_v130_llm_invoke_fixture(), encoding="utf-8", newline="\n")

        dry = subprocess.run(
            ["patch", "-p1", "--dry-run", "-i", str(PATCH_PATH)],
            cwd=tmpdir,
            capture_output=True,
            text=True,
            check=False,
        )
        if dry.returncode != 0:
            raise AssertionError(f"patch --dry-run failed: {dry.stdout}\n{dry.stderr}")

        applied = subprocess.run(
            ["patch", "-p1", "-i", str(PATCH_PATH)],
            cwd=tmpdir,
            capture_output=True,
            text=True,
            check=False,
        )
        if applied.returncode != 0:
            raise AssertionError(f"patch failed: {applied.stdout}\n{applied.stderr}")

        stub_modules: dict[str, types.ModuleType] = {}

        lc_core = types.ModuleType("langchain_core")
        lc_lm = types.ModuleType("langchain_core.language_models")
        lc_lm.BaseChatModel = _FakeBaseChatModel
        lc_msg = types.ModuleType("langchain_core.messages")
        lc_msg.BaseMessage = object
        lc_msg.HumanMessage = object
        lc_msg.SystemMessage = object
        stub_modules["langchain_core"] = lc_core
        stub_modules["langchain_core.language_models"] = lc_lm
        stub_modules["langchain_core.messages"] = lc_msg

        pydantic_mod = types.ModuleType("pydantic")
        pydantic_mod.BaseModel = type("BaseModel", (), {})
        pydantic_mod.ConfigDict = dict
        pydantic_mod.ValidationError = ValueError
        pydantic_mod.model_validator = lambda **_: (lambda fn: fn)
        stub_modules["pydantic"] = pydantic_mod

        ao_pkg = types.ModuleType("auto_ontology")
        ao_utils = types.ModuleType("auto_ontology.utils")
        ao_mc = types.ModuleType("auto_ontology.utils.model_config")
        ao_mc.resolve = lambda prefix, field: {
            "ENDPOINT": "http://flamingo.flamingo.svc.cluster.local/v1",
            "MODEL": "qwen38-flamingo",
            "API_KEY": "local",
        }[field]
        stub_modules["auto_ontology"] = ao_pkg
        stub_modules["auto_ontology.utils"] = ao_utils
        stub_modules["auto_ontology.utils.model_config"] = ao_mc

        lc_nvidia = types.ModuleType("langchain_nvidia_ai_endpoints")
        lc_nvidia.ChatNVIDIA = _FakeChatNVIDIA
        stub_modules["langchain_nvidia_ai_endpoints"] = lc_nvidia

        spec = importlib.util.spec_from_file_location("patched_llm_invoke", target)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, stub_modules):
            spec.loader.exec_module(module)
        return module, stub_modules


class NonReasoningThinkingPatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mod, cls.stub_modules = _load_patched_llm_invoke()

    def test_patch_file_uses_lf_line_endings_only(self) -> None:
        raw = PATCH_PATH.read_bytes()
        self.assertNotIn(b"\r\n", raw)

    def _capture_request(self, session, method: str, url: str, **kwargs):
        captured: dict[str, object] = {}

        def fake_super_request(self_session, req_method, req_url, **req_kwargs):
            captured["method"] = req_method
            captured["url"] = req_url
            captured["kwargs"] = req_kwargs
            return "ok"

        with patch.object(requests.Session, "request", autospec=True, side_effect=fake_super_request):
            result = session.request(method, url, **kwargs)
        self.assertEqual(result, "ok")
        return captured

    def test_json_payload_injects_enable_thinking_false_without_mutating_caller(self) -> None:
        session = self.mod._TimeoutSession(30, disable_thinking=True)
        payload = {"model": "qwen38-flamingo", "messages": [{"role": "user", "content": "hi"}]}
        captured = self._capture_request(
            session,
            "POST",
            "http://flamingo.flamingo.svc.cluster.local/v1/chat/completions",
            json=payload,
        )
        self.assertEqual(captured["kwargs"]["timeout"], 30)
        self.assertEqual(
            captured["kwargs"]["json"]["chat_template_kwargs"],
            {"enable_thinking": False},
        )
        self.assertNotIn("chat_template_kwargs", payload)

    def test_json_payload_preserves_existing_chat_template_kwargs(self) -> None:
        session = self.mod._TimeoutSession(30, disable_thinking=True)
        existing_ctk = {"add_generation_prompt": True}
        payload = {"model": "qwen38-flamingo", "chat_template_kwargs": existing_ctk}
        captured = self._capture_request(
            session,
            "POST",
            "http://flamingo.flamingo.svc.cluster.local/v1/chat/completions",
            json=payload,
        )
        self.assertEqual(
            captured["kwargs"]["json"]["chat_template_kwargs"],
            {"add_generation_prompt": True, "enable_thinking": False},
        )
        self.assertEqual(existing_ctk, {"add_generation_prompt": True})

        explicit_payload = {
            "model": "qwen38-flamingo",
            "chat_template_kwargs": {"enable_thinking": True},
        }
        explicit_captured = self._capture_request(
            session,
            "POST",
            "http://flamingo.flamingo.svc.cluster.local/v1/chat/completions",
            json=explicit_payload,
        )
        self.assertEqual(
            explicit_captured["kwargs"]["json"]["chat_template_kwargs"],
            {"enable_thinking": True},
        )

    def test_data_str_and_bytes_payloads_inject_and_drop_stale_content_length(self) -> None:
        session = self.mod._TimeoutSession(45, disable_thinking=True)
        body_str = json.dumps({"model": "qwen38-flamingo", "messages": []})
        headers = CaseInsensitiveDict(
            {"Content-Type": "application/json", "Content-Length": str(len(body_str)), "X-Test": "1"}
        )

        captured_str = self._capture_request(
            session,
            "post",
            "http://flamingo.flamingo.svc.cluster.local/v1/chat/completions?foo=bar",
            data=body_str,
            headers=headers,
        )
        self.assertIsInstance(captured_str["kwargs"]["data"], str)
        parsed_str = json.loads(captured_str["kwargs"]["data"])
        self.assertEqual(parsed_str["chat_template_kwargs"], {"enable_thinking": False})
        self.assertNotIn("Content-Length", captured_str["kwargs"]["headers"])
        self.assertEqual(captured_str["kwargs"]["headers"]["X-Test"], "1")
        self.assertIn("Content-Length", headers)

        body_bytes = body_str.encode("utf-8")
        captured_bytes = self._capture_request(
            session,
            "POST",
            "http://flamingo.flamingo.svc.cluster.local/v1/chat/completions/",
            data=body_bytes,
            headers={"content-length": str(len(body_bytes))},
        )
        self.assertIsInstance(captured_bytes["kwargs"]["data"], bytes)
        parsed_bytes = json.loads(captured_bytes["kwargs"]["data"].decode("utf-8"))
        self.assertEqual(parsed_bytes["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(captured_bytes["kwargs"]["headers"], {})

    def test_non_chat_or_non_json_requests_are_untouched(self) -> None:
        session = self.mod._TimeoutSession(30, disable_thinking=True)

        get_req = self._capture_request(
            session,
            "GET",
            "http://flamingo.flamingo.svc.cluster.local/v1/models",
            json={"model": "qwen38-flamingo"},
        )
        self.assertEqual(get_req["kwargs"]["json"], {"model": "qwen38-flamingo"})

        embed_req = self._capture_request(
            session,
            "POST",
            "http://saigak.saigak.svc.cluster.local:11434/v1/embeddings",
            json={"model": "qwen3-embedding-saigak:8b", "input": "hello"},
        )
        self.assertNotIn("chat_template_kwargs", embed_req["kwargs"]["json"])

        for raw_data in ("a=1&b=2", "{malformed", b"\xff\xfe", "[1, 2, 3]"):
            req = self._capture_request(
                session,
                "POST",
                "http://flamingo.flamingo.svc.cluster.local/v1/chat/completions",
                data=raw_data,
            )
            self.assertEqual(req["kwargs"]["data"], raw_data)

    def test_default_session_and_reasoning_client_never_disable_thinking(self) -> None:
        with patch.dict(sys.modules, self.stub_modules), patch.dict(
            os.environ, {"AUTO_ONTOLOGY_NON_REASONING_DISABLE_THINKING": "true"}
        ):
            reasoning_client = self.mod.get_llm_client()
            session = reasoning_client._client.get_session_fn()

        self.assertFalse(session._disable_thinking)
        payload = {"model": "qwen38-flamingo", "messages": []}
        captured = self._capture_request(
            session,
            "POST",
            "http://flamingo.flamingo.svc.cluster.local/v1/chat/completions",
            json=payload,
        )
        self.assertNotIn("chat_template_kwargs", captured["kwargs"]["json"])
        self.assertEqual(captured["kwargs"]["timeout"], self.mod.LLM_INVOKE_TIMEOUT_S)

    def test_non_reasoning_client_disables_thinking_by_default_and_honors_env_override(self) -> None:
        with patch.dict(sys.modules, self.stub_modules), patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AUTO_ONTOLOGY_NON_REASONING_DISABLE_THINKING", None)
            nr_client = self.mod.get_non_reasoning_llm_client()
            nr_session = nr_client._client.get_session_fn()
        self.assertTrue(nr_session._disable_thinking)

        captured = self._capture_request(
            nr_session,
            "POST",
            "http://flamingo.flamingo.svc.cluster.local/v1/chat/completions",
            json={"model": "qwen38-flamingo", "messages": []},
        )
        self.assertEqual(
            captured["kwargs"]["json"]["chat_template_kwargs"],
            {"enable_thinking": False},
        )

        for disabled_val in ("false", "FALSE", "0", "no", "off", " False "):
            with patch.dict(sys.modules, self.stub_modules), patch.dict(
                os.environ, {"AUTO_ONTOLOGY_NON_REASONING_DISABLE_THINKING": disabled_val}
            ):
                client = self.mod.get_non_reasoning_llm_client()
                self.assertFalse(client._client.get_session_fn()._disable_thinking, disabled_val)


if __name__ == "__main__":
    unittest.main()
