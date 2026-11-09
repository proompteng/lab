"""Exercise native MCTS auxiliary prompts without network access."""

import json
import unittest

from cosmosalpha.factors import build_base_field_catalog, build_base_operator_catalog
from cosmosalpha.llm.client import LLMResponse
from cosmosalpha.pipeline.mcts.controller import MCTSController
from cosmosalpha.pipeline.mcts.core import MCTSNode
from cosmosalpha.pipeline.mcts.portrait import generate_portrait


class RecordingClient:
    def __init__(self, content):
        self.content = content
        self.requests = []

    def complete(self, request):
        self.requests.append(request)
        return LLMResponse(
            content=json.dumps(self.content),
            model_alias=request.model_alias,
            prompt_render_id=request.prompt.prompt_render_id,
            finish_reason="stop",
            input_tokens=1,
            output_tokens=1,
        )


class MCTSPromptTests(unittest.TestCase):
    def test_suggestions_transmit_the_parent_prompt_with_the_json_object_contract(self):
        client = RecordingClient(
            {"suggestions": ["Normalize close by trailing volume."]}
        )
        controller = MCTSController(
            None,
            None,
            None,
            llm_client=client,
            field_catalog=build_base_field_catalog(),
            operator_catalog=build_base_operator_catalog(),
        )
        result = controller._step_a_suggest(
            MCTSNode(factor_id="fixture", expression="close")
        )
        self.assertEqual(len(client.requests), 1)
        request = client.requests[0]
        self.assertEqual(len(request.prompt.messages), 1)
        self.assertEqual(request.prompt.messages[0].role, "user")
        self.assertIn("Factor: close", request.prompt.messages[0].content)
        self.assertEqual(request.prompt.output_json_schema["type"], "object")
        self.assertEqual(request.max_output_tokens, 300)
        self.assertEqual(result, ["Normalize close by trailing volume."])

    def test_portrait_transmits_the_original_text_without_an_unsupported_request_argument(
        self,
    ):
        client = RecordingClient(
            {
                "portrait_name": "Fixture",
                "portrait_logic": "Observe close",
                "portrait_pseudocode": "return close",
                "expression": "close",
            }
        )
        result = generate_portrait(
            client, "Preserve this exact portrait prompt.", model_alias="fixture"
        )
        self.assertEqual(len(client.requests), 1)
        request = client.requests[0]
        self.assertEqual(len(request.prompt.messages), 1)
        self.assertEqual(
            request.prompt.messages[0].content, "Preserve this exact portrait prompt."
        )
        self.assertEqual(request.max_output_tokens, 800)
        self.assertIsNotNone(result)


if __name__ == "__main__":
    unittest.main()
