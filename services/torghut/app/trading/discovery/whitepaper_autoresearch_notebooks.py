"""Notebook diagnostics for whitepaper autoresearch epochs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, cast


NOTEBOOK_SCHEMA_VERSION = "torghut.whitepaper-autoresearch-diagnostics-notebook.v1"


def _markdown_cell(source: str) -> dict[str, Any]:
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": source.splitlines(keepends=True),
    }


def _code_cell(source: str) -> dict[str, Any]:
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": source.splitlines(keepends=True),
    }


def _json_object(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def build_whitepaper_autoresearch_diagnostics_notebook(
    *,
    summary: Mapping[str, Any],
) -> dict[str, Any]:
    portfolio_payload = _json_object(summary.get("best_portfolio_candidate"))
    scorecard_payload = _json_object(portfolio_payload.get("objective_scorecard"))
    artifact_payload = _json_object(summary.get("artifacts"))
    return {
        "cells": [
            _markdown_cell(
                "# Whitepaper Autoresearch Diagnostics\n\n"
                f"- Epoch: `{summary.get('epoch_id', '')}`\n"
                f"- Status: `{summary.get('status', '')}`\n"
                f"- Target net PnL/day: `{summary.get('target_net_pnl_per_day', '')}`\n"
                f"- Candidate specs: `{summary.get('candidate_spec_count', 0)}`\n"
                f"- Evidence bundles: `{summary.get('evidence_bundle_count', 0)}`\n"
            ),
            _markdown_cell(
                "## Best Portfolio\n\n"
                f"- Portfolio id: `{portfolio_payload.get('portfolio_candidate_id', '')}`\n"
                f"- Net PnL/day: `{scorecard_payload.get('net_pnl_per_day', '')}`\n"
                f"- Target met: `{scorecard_payload.get('target_met', '')}`\n"
                f"- Active day ratio: `{scorecard_payload.get('active_day_ratio', '')}`\n"
                f"- Positive day ratio: `{scorecard_payload.get('positive_day_ratio', '')}`\n"
            ),
            _code_cell(
                "from pathlib import Path\n"
                "import json\n\n"
                f"summary_path = Path({json.dumps(str(artifact_payload.get('summary', 'summary.json')))})\n"
                "summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}\n"
                "summary.get('best_portfolio_candidate')\n"
            ),
            _markdown_cell(
                "## Proposal Diagnostics\n\nFalse-positive and best false-negative tables from the epoch summary."
            ),
            _code_cell("summary.get('false_positive_table', [])\n"),
            _code_cell("summary.get('best_false_negative_table', [])\n"),
        ],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python", "pygments_lexer": "ipython3"},
            "torghut_schema_version": NOTEBOOK_SCHEMA_VERSION,
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def write_whitepaper_autoresearch_diagnostics_notebook(
    path: Path,
    *,
    summary: Mapping[str, Any],
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            build_whitepaper_autoresearch_diagnostics_notebook(summary=summary),
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return path
