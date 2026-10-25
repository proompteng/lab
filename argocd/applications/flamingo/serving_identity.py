"""Expose the loaded, revision-pinned vLLM model identity on responses."""

import json
import os
import re


class ServingIdentityMiddleware:
    def __init__(self, app):
        self.app = app
        self.image = os.environ["FLAMINGO_SERVING_IMAGE"]
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", self.image):
            raise ValueError("The serving image must be an immutable digest")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        state = scope["app"].state
        model = state.vllm_config.model_config
        revision = model.revision
        names = state.args.served_model_name
        if isinstance(names, str):
            names = [names]
        if (
            not isinstance(revision, str)
            or not re.fullmatch(r"[0-9a-f]{40}", revision)
            or model.hf_config._commit_hash != revision
            or model.tokenizer_revision != revision
            or model.tokenizer != model.model
            or state.args.chat_template is not None
            or state.args.trust_request_chat_template
            or len(names) != 1
        ):
            await send({"type": "http.response.start", "status": 503, "headers": []})
            await send(
                {"type": "http.response.body", "body": b"Unverified serving identity"}
            )
            return
        identity = json.dumps(
            {
                "model": names[0],
                "checkpoint": revision,
                "servingImage": self.image,
                "tokenizerRevision": revision,
                "chatTemplateRevision": revision,
            },
            separators=(",", ":"),
        ).encode()

        async def identified_send(message):
            if message["type"] == "http.response.start":
                message = {
                    **message,
                    "headers": [
                        (key, value)
                        for key, value in message.get("headers", [])
                        if key.lower() != b"x-model-serving-identity"
                    ]
                    + [(b"x-model-serving-identity", identity)],
                }
            await send(message)

        await self.app(scope, receive, identified_send)
