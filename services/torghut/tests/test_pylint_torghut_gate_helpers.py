from __future__ import annotations

from scripts.run_pylint_torghut_file_length_gate import (
    _filter_legacy_extracted_messages,
)
from scripts.run_pylint_torghut_quality_diff_gate import _source_literal_lines


def test_source_literal_lines_decodes_generated_payload_lines() -> None:
    module_text = "SOURCE = 'def hidden() -> int:\\n    return 42\\n'"

    lines = _source_literal_lines(module_text)

    assert lines == {"def hidden() -> int:", "return 42"}


def test_file_length_filter_ignores_only_extracted_source_paths() -> None:
    output = "\n".join(
        (
            "app/trading/research_sleeves.py:1:0: C0302: Too many lines in module (5658/1000) (too-many-lines)",
            "app/trading/new_long_module.py:1:0: C0302: Too many lines in module (1200/1000) (too-many-lines)",
        )
    )

    messages = _filter_legacy_extracted_messages(
        output,
        extracted_paths={"app/trading/research_sleeves.py"},
    )

    assert messages == [
        "app/trading/new_long_module.py:1:0: C0302: Too many lines in module (1200/1000) (too-many-lines)"
    ]
