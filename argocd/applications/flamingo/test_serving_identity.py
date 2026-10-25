import asyncio
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from serving_identity import ServingIdentityMiddleware


class ServingIdentityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.revision = "a" * 40
        self.image = "sha256:" + "b" * 64
        self.model = SimpleNamespace(
            model="unsloth/Qwen3.6-35B-A3B-NVFP4",
            tokenizer="unsloth/Qwen3.6-35B-A3B-NVFP4",
            revision=self.revision,
            tokenizer_revision=self.revision,
            hf_config=SimpleNamespace(_commit_hash=self.revision),
        )
        self.args = SimpleNamespace(
            served_model_name=["qwen36-flamingo"],
            chat_template=None,
            trust_request_chat_template=False,
        )
        self.scope = {
            "type": "http",
            "app": SimpleNamespace(
                state=SimpleNamespace(
                    args=self.args,
                    vllm_config=SimpleNamespace(model_config=self.model),
                )
            ),
        }
        self.messages = []

    async def send(self, message):
        self.messages.append(message)

    def middleware(self, app):
        with patch.dict(os.environ, FLAMINGO_SERVING_IMAGE=self.image):
            return ServingIdentityMiddleware(app)

    async def test_identifies_loaded_model_without_buffering_stream(self):
        chunks = [bytes([i]) for i in range(100)]

        async def app(scope, receive, send):
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"x-model-serving-identity", b"forged")],
                }
            )
            for chunk in chunks:
                await send({"type": "http.response.body", "body": chunk})
                self.assertEqual(self.messages[-1]["body"], chunk)

        await self.middleware(app)(self.scope, None, self.send)
        headers = self.messages[0]["headers"]
        self.assertEqual(len(headers), 1)
        self.assertEqual(
            json.loads(headers[0][1]),
            {
                "model": "qwen36-flamingo",
                "checkpoint": self.revision,
                "servingImage": self.image,
                "tokenizerRevision": self.revision,
                "chatTemplateRevision": self.revision,
            },
        )
        self.assertEqual([x["body"] for x in self.messages[1:]], chunks)

    async def test_rejects_unpinned_or_different_loaded_artifacts_before_dispatch(self):
        cases = [
            (self.model, "revision", None),
            (self.model.hf_config, "_commit_hash", "c" * 40),
            (self.model, "tokenizer_revision", "c" * 40),
            (self.model, "tokenizer", "foreign/model"),
            (self.args, "chat_template", "override"),
            (self.args, "trust_request_chat_template", True),
            (self.args, "served_model_name", ["one", "two"]),
        ]

        async def app(*_):
            self.fail("Unverified artifacts must not dispatch inference")

        for obj, name, value in cases:
            with self.subTest(field=name), patch.object(obj, name, value):
                self.messages.clear()
                await self.middleware(app)(self.scope, None, self.send)
                self.assertEqual(self.messages[0]["status"], 503)

    async def test_preserves_cancellation(self):
        async def app(*_):
            raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await self.middleware(app)(self.scope, None, self.send)

    async def test_preserves_lifespan(self):
        observed = []

        async def app(scope, *_):
            observed.append(scope["type"])

        await self.middleware(app)({"type": "lifespan"}, None, self.send)
        self.assertEqual(observed, ["lifespan"])

    def test_rejects_mutable_image(self):
        with patch.dict(os.environ, FLAMINGO_SERVING_IMAGE="latest"):
            with self.assertRaises(ValueError):
                ServingIdentityMiddleware(None)
