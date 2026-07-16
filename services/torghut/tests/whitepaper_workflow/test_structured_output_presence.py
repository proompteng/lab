from __future__ import annotations

import pytest

from app.whitepapers.workflow.whitepaper_workflow_api_methods import (
    WhitepaperWorkflowApiMethods,
)


@pytest.mark.parametrize(
    "payload",
    (
        {"status": "completed", "claims": None},
        {"status": "completed", "claims": {}},
        {"status": "completed", "synthesis": {"claims": None}},
        {"status": "completed", "synthesis": {"claims": "omitted"}},
    ),
)
def test_non_list_structured_values_do_not_replace_persisted_outputs(
    payload: dict[str, object],
) -> None:
    assert not WhitepaperWorkflowApiMethods._has_structured_research_outputs(payload)


@pytest.mark.parametrize(
    "payload",
    (
        {"claims": []},
        {"synthesis": {"claims": []}},
        {"claim_relations": [{"source": "a", "target": "b"}]},
        {"synthesis": {"strategy_templates": [{"template_id": "t1"}]}},
    ),
)
def test_list_structured_values_authorize_replace_or_explicit_clear(
    payload: dict[str, object],
) -> None:
    assert WhitepaperWorkflowApiMethods._has_structured_research_outputs(payload)
