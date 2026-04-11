"""Notebook generation helpers for strategy autoresearch runs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _markdown_cell(source: str) -> dict[str, Any]:
    return {
        'cell_type': 'markdown',
        'metadata': {},
        'source': source.splitlines(keepends=True),
    }


def _code_cell(source: str) -> dict[str, Any]:
    return {
        'cell_type': 'code',
        'metadata': {},
        'execution_count': None,
        'outputs': [],
        'source': source.splitlines(keepends=True),
    }


def _notebook(cells: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        'cells': cells,
        'metadata': {
            'kernelspec': {
                'display_name': 'Python 3',
                'language': 'python',
                'name': 'python3',
            },
            'language_info': {
                'name': 'python',
                'version': '3.11',
            },
        },
        'nbformat': 4,
        'nbformat_minor': 5,
    }


def _shared_loader_code(run_root: Path) -> str:
    resolved = run_root.resolve().as_posix()
    return f"""from __future__ import annotations

from collections import Counter
from decimal import Decimal
from html import escape
from pathlib import Path
import json

try:
    import pandas as pd
except ModuleNotFoundError:
    pd = None

try:
    from IPython.display import HTML, Markdown, SVG, display
except ModuleNotFoundError:
    class HTML(str):
        pass

    class Markdown(str):
        pass

    class SVG(str):
        pass

    def display(*items: object) -> None:
        for item in items:
            print(item)

RUN_ROOT = Path('{resolved}')
SUMMARY = json.loads((RUN_ROOT / 'summary.json').read_text(encoding='utf-8'))
RESEARCH = json.loads((RUN_ROOT / 'research_dossier.json').read_text(encoding='utf-8'))
HISTORY = [
    json.loads(line)
    for line in (RUN_ROOT / 'history.jsonl').read_text(encoding='utf-8').splitlines()
    if line.strip()
]
RESULTS_TSV = RUN_ROOT / 'results.tsv'

def _to_decimal(value: object) -> Decimal:
    return Decimal(str(value or '0'))

def _mapping(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {{}}

EXPERIMENT_RESULTS = []
for result_path in sorted((RUN_ROOT / 'experiments').glob('*/result.json')):
    try:
        payload = json.loads(result_path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        continue
    if not isinstance(payload, dict):
        continue
    top = payload.get('top') or [{{}}]
    top_row = _mapping(top[0]) if isinstance(top, list) and top else {{}}
    top_scorecard = _mapping(top_row.get('objective_scorecard'))
    EXPERIMENT_RESULTS.append(
        {{
            'experiment': result_path.parent.name,
            'path': str(result_path),
            'status': payload.get('status'),
            'candidate_count': payload.get('candidate_count'),
            'evaluated_candidates': _mapping(payload.get('progress')).get('evaluated_candidates'),
            'pending_candidates': _mapping(payload.get('progress')).get('pending_candidates'),
            'top_candidate_id': top_row.get('candidate_id'),
            'top_net_pnl_per_day': top_scorecard.get('net_pnl_per_day'),
            'top_active_day_ratio': top_scorecard.get('active_day_ratio'),
            'top_best_day_share': top_scorecard.get('best_day_share'),
        }}
    )

def _ordered_keys(rows: list[dict[str, object]]) -> list[str]:
    keys: list[str] = []
    for row in rows:
        for key in row.keys():
            if key not in keys:
                keys.append(key)
    return keys

def _display_rows(rows: list[dict[str, object]], *, columns: list[str] | None = None) -> None:
    rows = list(rows)
    if columns is None:
        columns = _ordered_keys(rows)
    if pd is not None:
        frame = pd.DataFrame(rows)
        if columns:
            frame = frame.reindex(columns=columns)
        display(frame)
        return
    if not columns:
        display(Markdown('_No rows_'))
        return
    header = ''.join(f'<th>{{escape(str(column))}}</th>' for column in columns)
    body_rows = []
    for row in rows:
        cells = ''.join(f'<td>{{escape(str(row.get(column, "")))}}</td>' for column in columns)
        body_rows.append(f'<tr>{{cells}}</tr>')
    if not body_rows:
        body_rows.append(f'<tr><td colspan="{{len(columns)}}"><em>No rows</em></td></tr>')
    display(
        HTML(
            '<table style="border-collapse: collapse; width: 100%;">'
            f'<thead><tr>{{header}}</tr></thead>'
            f'<tbody>{{"".join(body_rows)}}</tbody>'
            '</table>'
        )
    )

def _project_rows(rows: list[dict[str, object]], columns: list[str]) -> list[dict[str, object]]:
    return [{{column: row.get(column) for column in columns}} for row in rows]

def _to_float(value: object) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0

def _svg_line(points: list[Decimal], *, width: int = 720, height: int = 220, stroke: str = '#111827') -> str:
    if not points:
        return '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="220"></svg>'
    numeric = [float(item) for item in points]
    minimum = min(numeric)
    maximum = max(numeric)
    spread = maximum - minimum or 1.0
    x_step = width / max(len(points) - 1, 1)
    def _y(value: float) -> float:
        return height - (((value - minimum) / spread) * (height - 20)) - 10
    coords = ' '.join(
        f'{{index * x_step:.1f}},{{_y(value):.1f}}'
        for index, value in enumerate(numeric)
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{{width}}" height="{{height}}" viewBox="0 0 {{width}} {{height}}">'
        f'<polyline fill="none" stroke="{{stroke}}" stroke-width="3" points="{{coords}}" />'
        '</svg>'
    )

display(Markdown(f"## Run Root\\n`{{RUN_ROOT}}`"))
display(Markdown(f"## Program\\n`{{RESEARCH['program_id']}}`"))
if pd is None:
    display(Markdown('> `pandas` is not installed in this kernel, so the notebook is using a lightweight HTML table renderer.'))
"""


def build_strategy_discovery_history_notebook(run_root: Path) -> dict[str, Any]:
    cells = [
        _markdown_cell(
            '# Strategy Discovery History\n\n'
            'This notebook shows the autoresearch loop over time: which candidates were kept, '
            'how the frontier improved, and where concentration or inactivity still remains.\n\n'
            '> Results in this notebook are research candidates only. They are not promotable until '
            'the same family passes runtime parity, scheduler-v3 approval replay, and shadow validation.'
        ),
        _code_cell(_shared_loader_code(run_root)),
        _code_cell(
            """objective_rows = [
    {'metric': key, 'target': value}
    for key, value in RESEARCH['objective'].items()
]
_display_rows(objective_rows, columns=['metric', 'target'])

best = SUMMARY.get('best_candidate') or {}
display(Markdown('## Best Candidate Summary'))
_display_rows([best])

promotion = SUMMARY.get('promotion_readiness') or {}
if promotion:
    display(Markdown('## Promotion Guardrail'))
    _display_rows(
        [
            {
                'candidate_id': promotion.get('candidate_id'),
                'family_template_id': promotion.get('family_template_id'),
                'status': promotion.get('status'),
                'stage': promotion.get('stage'),
                'promotable': promotion.get('promotable'),
                'runtime_family': promotion.get('runtime_family'),
                'runtime_strategy_name': promotion.get('runtime_strategy_name'),
                'reason': promotion.get('reason'),
            }
        ]
    )
    blockers = promotion.get('blockers') or []
    if blockers:
        display(Markdown('### Missing Promotion Evidence'))
        _display_rows([{'blocker': blocker} for blocker in blockers], columns=['blocker'])
"""
        ),
        _code_cell(
            """if EXPERIMENT_RESULTS:
    display(Markdown('## Live Experiment Snapshots'))
    experiment_columns = [
        'experiment',
        'status',
        'candidate_count',
        'evaluated_candidates',
        'pending_candidates',
        'top_candidate_id',
        'top_net_pnl_per_day',
        'top_active_day_ratio',
        'top_best_day_share',
    ]
    _display_rows(_project_rows(EXPERIMENT_RESULTS, experiment_columns), columns=experiment_columns)
"""
        ),
        _code_cell(
            """sources = []
for source in RESEARCH.get('research_sources', []):
    claims = '; '.join(claim.get('summary', '') for claim in source.get('claims', []))
    sources.append(
        {
            'source_id': source.get('source_id'),
            'title': source.get('title'),
            'published_at': source.get('published_at'),
            'url': source.get('url'),
            'claims': claims,
        }
    )
if sources:
    display(Markdown('## Research Sources'))
    _display_rows(sources)
"""
        ),
        _code_cell(
            """if not HISTORY:
    display(Markdown('No history recorded.'))
else:
    display(Markdown('## Experiment Ledger'))
    ledger_columns = [
        'experiment_index',
        'iteration',
        'family_template_id',
        'candidate_id',
        'status',
        'net_pnl_per_day',
        'active_day_ratio',
        'positive_day_ratio',
        'avg_filled_notional_per_day',
        'best_day_share',
        'max_drawdown',
        'pareto_tier',
        'mutation_label',
        'promotion_status',
        'runtime_strategy_name',
    ]
    _display_rows(_project_rows(HISTORY, ledger_columns), columns=ledger_columns)
"""
        ),
        _code_cell(
            """if HISTORY:
    ranked = sorted(
        HISTORY,
        key=lambda row: (
            int(row.get('iteration') or 0),
            int(row.get('pareto_tier') or 0),
            -_to_float(row.get('net_pnl_per_day')),
        ),
    )
    best_by_iteration = []
    seen_iterations = set()
    for row in ranked:
        iteration = int(row.get('iteration') or 0)
        if iteration in seen_iterations:
            continue
        seen_iterations.add(iteration)
        best_by_iteration.append(row)
    display(Markdown('## Best Candidate Per Iteration'))
    best_columns = ['iteration', 'candidate_id', 'net_pnl_per_day', 'active_day_ratio', 'best_day_share', 'max_drawdown']
    _display_rows(_project_rows(best_by_iteration, best_columns), columns=best_columns)
    display(Markdown('### Net PnL / Day'))
    display(SVG(_svg_line([_to_decimal(item.get('net_pnl_per_day')) for item in best_by_iteration])))
    display(Markdown('### Active Day Ratio'))
    display(SVG(_svg_line([_to_decimal(item.get('active_day_ratio')) for item in best_by_iteration], stroke='#2563eb')))
    display(Markdown('### Best-Day Share'))
    display(SVG(_svg_line([_to_decimal(item.get('best_day_share')) for item in best_by_iteration], stroke='#dc2626')))
"""
        ),
        _code_cell(
            """if HISTORY:
    display(Markdown('## Keep / Discard Mix'))
    status_counts = Counter(item.get('status', '<missing>') for item in HISTORY)
    _display_rows([dict(status_counts)])

    veto_counts = Counter()
    for raw_vetoes in [item.get('hard_vetoes') or [] for item in HISTORY]:
        for veto in raw_vetoes:
            veto_counts[veto] += 1
    if veto_counts:
        display(Markdown('## Hard Veto Counts'))
        _display_rows(
            [{'hard_veto': key, 'count': value} for key, value in veto_counts.items()],
            columns=['hard_veto', 'count'],
        )
"""
        ),
        _code_cell(
            """best = SUMMARY.get('best_candidate') or {}
daily_net = best.get('daily_net') or {}
if daily_net:
    display(Markdown('## Best Candidate Daily Net'))
    daily_rows = sorted(
        [{'trading_day': day, 'net_pnl': value} for day, value in daily_net.items()],
        key=lambda item: item['trading_day'],
    )
    _display_rows(daily_rows, columns=['trading_day', 'net_pnl'])
    display(SVG(_svg_line([_to_decimal(item['net_pnl']) for item in daily_rows], stroke='#059669')))
"""
        ),
    ]
    return _notebook(cells)


def build_strategy_research_dossier_notebook(run_root: Path) -> dict[str, Any]:
    cells = [
        _markdown_cell(
            '# Strategy Research Dossier\n\n'
            'This notebook focuses on the paper claims and family plans that drove the discovery loop.\n\n'
            '> Discovery evidence is not promotion evidence. Use runtime parity and scheduler-v3 approval replay '
            'before calling any candidate a winner.'
        ),
        _code_cell(_shared_loader_code(run_root)),
        _code_cell(
            """display(Markdown('## Objective Contract'))
_display_rows(
    [{'metric': key, 'target': value} for key, value in RESEARCH['objective'].items()],
    columns=['metric', 'target'],
)

display(Markdown('## Family Plans'))
family_rows = []
for family in RESEARCH.get('families', []):
    family_rows.append(
        {
            'family_template_id': family.get('family_template_id'),
            'seed_sweep_config': family.get('seed_sweep_config'),
            'max_iterations': family.get('max_iterations'),
            'keep_top_candidates': family.get('keep_top_candidates'),
            'frontier_top_n': family.get('frontier_top_n'),
            'symbol_prune_iterations': family.get('symbol_prune_iterations'),
        }
    )
_display_rows(family_rows)

promotion = SUMMARY.get('promotion_readiness') or {}
if promotion:
    display(Markdown('## Promotion Status'))
    _display_rows([promotion])
"""
        ),
        _code_cell(
            """claim_rows = []
for source in RESEARCH.get('research_sources', []):
    for claim in source.get('claims', []):
        claim_rows.append(
            {
                'source_id': source.get('source_id'),
                'title': source.get('title'),
                'claim_id': claim.get('claim_id'),
                'summary': claim.get('summary'),
                'implication': claim.get('implication'),
                'url': source.get('url'),
            }
        )
display(Markdown('## Claim Graph Seed'))
_display_rows(claim_rows)
"""
        ),
        _code_cell(
            """if HISTORY:
    display(Markdown('## Families That Improved'))
    best_by_family = []
    seen_families = set()
    for row in sorted(HISTORY, key=lambda item: (str(item.get('family_template_id') or ''), -_to_float(item.get('net_pnl_per_day')))):
        family_template_id = str(row.get('family_template_id') or '')
        if family_template_id in seen_families:
            continue
        seen_families.add(family_template_id)
        best_by_family.append(row)
    _display_rows(
        _project_rows(
            best_by_family,
            ['family_template_id', 'candidate_id', 'net_pnl_per_day', 'active_day_ratio', 'best_day_share'],
        ),
        columns=['family_template_id', 'candidate_id', 'net_pnl_per_day', 'active_day_ratio', 'best_day_share'],
    )
"""
        ),
    ]
    return _notebook(cells)


def build_mlx_autoresearch_diagnostics_notebook(run_root: Path) -> dict[str, Any]:
    resolved = run_root.resolve().as_posix()
    cells = [
        _markdown_cell(
            '# MLX Autoresearch Diagnostics\n\n'
            'This notebook visualizes MLX proposal metadata, snapshot health, runtime replay outcomes, '
            'and promotion blocking for one autoresearch run.\n\n'
            '> MLX proposal scores are diagnostic only. Scheduler-v3 replay remains the authority.'
        ),
        _code_cell(
            f"""from __future__ import annotations

from html import escape
from pathlib import Path
import json

try:
    import pandas as pd
except ModuleNotFoundError:
    pd = None

try:
    from IPython.display import HTML, Markdown, SVG, display
except ModuleNotFoundError:
    class HTML(str):
        pass

    class Markdown(str):
        pass

    class SVG(str):
        pass

    def display(*items: object) -> None:
        for item in items:
            print(item)

RUN_ROOT = Path('{resolved}')
SUMMARY = json.loads((RUN_ROOT / 'summary.json').read_text(encoding='utf-8'))
MANIFEST = json.loads((RUN_ROOT / 'mlx-snapshot-manifest.json').read_text(encoding='utf-8'))
DESCRIPTORS = [
    json.loads(line)
    for line in (RUN_ROOT / 'mlx-candidate-descriptors.jsonl').read_text(encoding='utf-8').splitlines()
    if line.strip()
]
PROPOSALS = [
    json.loads(line)
    for line in (RUN_ROOT / 'mlx-proposal-scores.jsonl').read_text(encoding='utf-8').splitlines()
    if line.strip()
]
DIAGNOSTICS = json.loads((RUN_ROOT / 'mlx-proposal-diagnostics.json').read_text(encoding='utf-8'))
HISTORY = [
    json.loads(line)
    for line in (RUN_ROOT / 'history.jsonl').read_text(encoding='utf-8').splitlines()
    if line.strip()
]
RUNTIME_CLOSURE = SUMMARY.get('runtime_closure') or {{}}

def _load_optional_json(path_value: object) -> dict[str, object]:
    raw = str(path_value or '').strip()
    if not raw:
        return {{}}
    path = Path(raw)
    if not path.is_absolute():
        path = RUN_ROOT / path
    if not path.exists():
        return {{}}
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {{}}
    return payload if isinstance(payload, dict) else {{}}

RUNTIME_PARITY_REPORT = _load_optional_json(RUNTIME_CLOSURE.get('parity_report_path'))
RUNTIME_APPROVAL_REPORT = _load_optional_json(RUNTIME_CLOSURE.get('approval_report_path'))
RUNTIME_SHADOW_VALIDATION = _load_optional_json(RUNTIME_CLOSURE.get('shadow_validation_path'))
RUNTIME_PROMOTION_PREREQUISITES = _load_optional_json(RUNTIME_CLOSURE.get('promotion_prerequisites_path'))

def _ordered_keys(rows: list[dict[str, object]]) -> list[str]:
    keys: list[str] = []
    for row in rows:
        for key in row.keys():
            if key not in keys:
                keys.append(key)
    return keys

def _display_rows(rows: list[dict[str, object]], *, columns: list[str] | None = None) -> None:
    rows = list(rows)
    if columns is None:
        columns = _ordered_keys(rows)
    if pd is not None:
        frame = pd.DataFrame(rows)
        if columns:
            frame = frame.reindex(columns=columns)
        display(frame)
        return
    header = ''.join(f'<th>{{escape(str(column))}}</th>' for column in (columns or []))
    body_rows = []
    for row in rows:
        cells = ''.join(f'<td>{{escape(str(row.get(column, "")))}}</td>' for column in (columns or []))
        body_rows.append(f'<tr>{{cells}}</tr>')
    display(HTML('<table><thead><tr>' + header + '</tr></thead><tbody>' + ''.join(body_rows) + '</tbody></table>'))

def _svg_line(values: list[float], *, stroke: str = '#111827') -> str:
    width = 720
    height = 220
    if not values:
        return '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="220"></svg>'
    minimum = min(values)
    maximum = max(values)
    spread = maximum - minimum or 1.0
    x_step = width / max(len(values) - 1, 1)
    def _y(value: float) -> float:
        return height - (((value - minimum) / spread) * (height - 20)) - 10
    coords = ' '.join(f'{{idx * x_step:.1f}},{{_y(value):.1f}}' for idx, value in enumerate(values))
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{{width}}" height="{{height}}" viewBox="0 0 {{width}} {{height}}">'
        f'<polyline fill="none" stroke="{{stroke}}" stroke-width="3" points="{{coords}}" />'
        '</svg>'
    )

def _svg_bar(labels: list[str], values: list[float], *, fill: str = '#2563eb') -> str:
    width = 720
    height = 260
    if not labels or not values:
        return '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="260"></svg>'
    maximum = max(values) or 1.0
    slot_width = width / max(len(values), 1)
    bar_width = max(12.0, slot_width - 10.0)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{{width}}" height="{{height}}" viewBox="0 0 {{width}} {{height}}">']
    for idx, (label, value) in enumerate(zip(labels, values)):
        scaled = (value / maximum) * (height - 70)
        x = (idx * slot_width) + ((slot_width - bar_width) / 2.0)
        y = height - scaled - 40
        parts.append(f'<rect x="{{x:.1f}}" y="{{y:.1f}}" width="{{bar_width:.1f}}" height="{{scaled:.1f}}" fill="{{fill}}" rx="4" />')
        parts.append(f'<text x="{{x + (bar_width / 2.0):.1f}}" y="{{height - 18}}" text-anchor="middle" font-size="12">{{escape(label)}}</text>')
        parts.append(f'<text x="{{x + (bar_width / 2.0):.1f}}" y="{{max(14.0, y - 6):.1f}}" text-anchor="middle" font-size="12">{{value:.2f}}</text>')
    parts.append('</svg>')
    return ''.join(parts)

def _svg_scatter(points: list[tuple[float, float]], *, fill: str = '#059669') -> str:
    width = 720
    height = 260
    if not points:
        return '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="260"></svg>'
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    x_span = x_max - x_min or 1.0
    y_span = y_max - y_min or 1.0
    circles = []
    for x_value, y_value in points:
        x = 30 + (((x_value - x_min) / x_span) * (width - 60))
        y = height - 30 - (((y_value - y_min) / y_span) * (height - 60))
        circles.append(f'<circle cx="{{x:.1f}}" cy="{{y:.1f}}" r="5" fill="{{fill}}" opacity="0.8" />')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{{width}}" height="{{height}}" viewBox="0 0 {{width}} {{height}}">'
        + ''.join(circles)
        + '</svg>'
    )
"""
        ),
        _code_cell(
            """display(Markdown('## Run summary'))
_display_rows(
    [
        {
            'runner_run_id': SUMMARY.get('runner_run_id'),
            'snapshot_id': MANIFEST.get('snapshot_id'),
            'program_id': SUMMARY.get('program_id'),
            'train_days': MANIFEST.get('train_days'),
            'holdout_days': MANIFEST.get('holdout_days'),
            'full_window_days': MANIFEST.get('full_window_days'),
        }
    ]
)

display(Markdown('## Snapshot health'))
_display_rows(
    [
        {
            'bar_interval': MANIFEST.get('bar_interval'),
            'feature_set_id': MANIFEST.get('feature_set_id'),
            'quote_quality_policy_id': MANIFEST.get('quote_quality_policy_id'),
            'symbols': len(MANIFEST.get('symbols') or []),
            'receipt_count': (MANIFEST.get('row_counts') or {}).get('receipt_count'),
            'latest_row_count': (MANIFEST.get('row_counts') or {}).get('latest_receipt_row_count'),
        }
    ]
)
"""
        ),
        _code_cell(
            """if DESCRIPTORS:
    display(Markdown('## Descriptor coverage'))
    descriptor_columns = [
        'candidate_id',
        'family_template_id',
        'side_policy',
        'entry_window_start_minute',
        'entry_window_end_minute',
        'rank_count',
        'normalization_regime',
    ]
    _display_rows([{column: row.get(column) for column in descriptor_columns} for row in DESCRIPTORS], columns=descriptor_columns)
"""
        ),
        _code_cell(
            """if PROPOSALS:
    display(Markdown('## Proposal model diagnostics'))
    proposal_columns = ['candidate_id', 'descriptor_id', 'score', 'rank', 'backend', 'mode']
    _display_rows([{column: row.get(column) for column in proposal_columns} for row in PROPOSALS], columns=proposal_columns)
    display(Markdown('### Proposal score distribution'))
    histogram = DIAGNOSTICS.get('score_histogram') or []
    display(SVG(_svg_bar([str(item.get('bucket_label') or '') for item in histogram], [float(item.get('count') or 0.0) for item in histogram], fill='#2563eb')))
    display(Markdown('### Family proposal volume'))
    family_volume = DIAGNOSTICS.get('family_volume') or []
    display(SVG(_svg_bar([str(item.get('family_template_id') or '') for item in family_volume], [float(item.get('candidate_count') or 0.0) for item in family_volume], fill='#7c3aed')))
    selected_columns = ['candidate_id', 'selection_reason', 'score', 'rank', 'family_template_id', 'side_policy']
    selected = DIAGNOSTICS.get('selected_candidates') or []
    if selected:
        display(Markdown('### Selected proposal batch'))
        _display_rows([{column: row.get(column) for column in selected_columns} for row in selected], columns=selected_columns)
"""
        ),
        _code_cell(
            """if HISTORY:
    display(Markdown('## Replay outcome comparison'))
    columns = [
        'candidate_id',
        'proposal_rank',
        'proposal_score',
        'net_pnl_per_day',
        'active_day_ratio',
        'best_day_share',
        'promotion_status',
    ]
    _display_rows([{column: row.get(column) for column in columns} for row in HISTORY], columns=columns)
    display(Markdown('### Proposal score vs realized net/day'))
    scatter_points = [
        (float(row.get('proposal_score') or 0.0), float(row.get('net_pnl_per_day') or 0.0))
        for row in HISTORY
    ]
    display(SVG(_svg_scatter(scatter_points, fill='#059669')))
"""
        ),
        _code_cell(
            """display(Markdown('## Calibration and error analysis'))
rank_buckets = DIAGNOSTICS.get('rank_bucket_lift') or []
if rank_buckets:
    _display_rows(rank_buckets, columns=['bucket_label', 'candidate_count', 'mean_proposal_score', 'mean_net_pnl_per_day', 'positive_rate'])
    display(Markdown('### Rank-bucket lift'))
    display(SVG(_svg_bar([str(item.get('bucket_label') or '') for item in rank_buckets], [float(item.get('mean_net_pnl_per_day') or 0.0) for item in rank_buckets], fill='#0f766e')))
false_positives = DIAGNOSTICS.get('worst_false_positives') or []
if false_positives:
    display(Markdown('### Worst false positives'))
    _display_rows(false_positives, columns=['candidate_id', 'proposal_rank', 'proposal_score', 'net_pnl_per_day'])
false_negatives = DIAGNOSTICS.get('best_false_negatives') or []
if false_negatives:
    display(Markdown('### Best false negatives'))
    _display_rows(false_negatives, columns=['candidate_id', 'proposal_rank', 'proposal_score', 'net_pnl_per_day'])
"""
        ),
        _code_cell(
            """if HISTORY:
    display(Markdown('## Parity and authority checks'))
    parity = DIAGNOSTICS.get('parity_matrix') or {}
    _display_rows(
        [
            {
                'research_candidates': parity.get('proposed_count'),
                'replayed_candidates': parity.get('replayed_count'),
                'kept_candidates': parity.get('keep_count'),
                'objective_met_count': parity.get('objective_met_count'),
                'blocked_promotions': parity.get('blocked_promotion_count'),
                'runtime_family_mapped': sum(1 for row in HISTORY if row.get('runtime_family')),
                'proposal_backend': ', '.join(sorted({str(row.get('proposal_backend') or '') for row in HISTORY if row.get('proposal_backend')})),
            }
        ]
    )
    display(Markdown('### Selection diversity'))
    _display_rows([DIAGNOSTICS.get('diversity_summary') or {}], columns=['selected_unique_family_count', 'selected_unique_side_count', 'selected_mean_pairwise_distance'])
    if RUNTIME_CLOSURE:
        display(Markdown('### Runtime closure evidence'))
        _display_rows(
            [
                {
                    'runtime_closure_status': RUNTIME_CLOSURE.get('status'),
                    'next_required_steps': ', '.join(RUNTIME_CLOSURE.get('next_required_steps') or []),
                    'parity_objective_met': RUNTIME_PARITY_REPORT.get('objective_met'),
                    'approval_objective_met': RUNTIME_APPROVAL_REPORT.get('objective_met'),
                    'shadow_validation_status': RUNTIME_SHADOW_VALIDATION.get('status'),
                    'shadow_evidence_loaded': RUNTIME_SHADOW_VALIDATION.get('evidence_loaded'),
                    'shadow_artifact_path': RUNTIME_SHADOW_VALIDATION.get('source_artifact_path'),
                }
            ]
        )
        if RUNTIME_PROMOTION_PREREQUISITES:
            display(Markdown('### Promotion prerequisites'))
            _display_rows(
                [
                    {
                        'allowed': RUNTIME_PROMOTION_PREREQUISITES.get('allowed'),
                        'reasons': ', '.join(RUNTIME_PROMOTION_PREREQUISITES.get('reasons') or []),
                        'missing_artifacts': ', '.join(RUNTIME_PROMOTION_PREREQUISITES.get('missing_artifacts') or []),
                    }
                ]
            )
"""
        ),
        _code_cell(
            """display(Markdown('## Open failures'))
if HISTORY:
    _display_rows(
        [
            {
                'candidate_id': row.get('candidate_id'),
                'proposal_selected': row.get('proposal_selected'),
                'proposal_selection_reason': row.get('proposal_selection_reason'),
                'promotion_status': row.get('promotion_status'),
                'runtime_strategy_name': row.get('runtime_strategy_name'),
                'hard_vetoes': row.get('hard_vetoes'),
            }
            for row in HISTORY
            if (not row.get('runtime_family')) or row.get('promotion_status') or row.get('hard_vetoes')
        ]
    )
if RUNTIME_CLOSURE:
    runtime_failures = [
        {
            'runtime_closure_status': RUNTIME_CLOSURE.get('status'),
            'shadow_validation_status': RUNTIME_SHADOW_VALIDATION.get('status'),
            'shadow_reasons': RUNTIME_SHADOW_VALIDATION.get('reasons'),
            'promotion_prerequisite_reasons': RUNTIME_PROMOTION_PREREQUISITES.get('reasons'),
        }
    ]
    _display_rows(runtime_failures)
"""
        ),
    ]
    return _notebook(cells)


def write_autoresearch_notebooks(run_root: Path) -> tuple[Path, ...]:
    history_path = run_root / 'strategy-discovery-history.ipynb'
    dossier_path = run_root / 'strategy-research-dossier.ipynb'
    mlx_path = run_root / 'mlx-autoresearch-diagnostics.ipynb'
    history_path.write_text(
        json.dumps(build_strategy_discovery_history_notebook(run_root), indent=2),
        encoding='utf-8',
    )
    dossier_path.write_text(
        json.dumps(build_strategy_research_dossier_notebook(run_root), indent=2),
        encoding='utf-8',
    )
    mlx_path.write_text(
        json.dumps(build_mlx_autoresearch_diagnostics_notebook(run_root), indent=2),
        encoding='utf-8',
    )
    return history_path, dossier_path, mlx_path


def build_strategy_factory_history_notebook(run_root: Path) -> dict[str, Any]:
    cells = [
        _markdown_cell(
            '# Strategy Factory History\n\n'
            'This notebook shows claim-linked factory experiments, candidate ranking, and the best-candidate decomposition.'
        ),
        _code_cell(_shared_loader_code(run_root)),
        _code_cell(
            """display(Markdown('## Summary'))
_display_rows(
    [
        {
            'runner_run_id': SUMMARY.get('runner_run_id'),
            'status': SUMMARY.get('status'),
            'count': SUMMARY.get('count'),
            'persisted': SUMMARY.get('persisted'),
        }
    ]
)

best = SUMMARY.get('best_candidate') or {}
if best:
    display(Markdown('## Best Candidate'))
    _display_rows([best])
"""
        ),
        _code_cell(
            """if HISTORY:
    display(Markdown('## Experiment Ledger'))
    columns = [
        'source_run_id',
        'experiment_id',
        'family_template_id',
        'candidate_id',
        'status',
        'net_pnl_per_day',
        'active_day_ratio',
        'avg_filled_notional_per_day',
        'best_day_share',
        'max_drawdown',
        'pareto_tier',
        'hard_vetoes',
    ]
    _display_rows(_project_rows(HISTORY, columns), columns=columns)
"""
        ),
        _code_cell(
            """if HISTORY:
    kept_rows = [row for row in HISTORY if row.get('status') == 'keep']
    if kept_rows:
        display(Markdown('## Kept Candidates'))
        columns = [
            'experiment_id',
            'candidate_id',
            'net_pnl_per_day',
            'active_day_ratio',
            'positive_day_ratio',
            'best_day_share',
            'max_drawdown',
        ]
        _display_rows(_project_rows(kept_rows, columns), columns=columns)
"""
        ),
        _code_cell(
            """best = SUMMARY.get('best_candidate') or {}
decomposition = best.get('decomposition') or {}
if decomposition:
    for section in ['days', 'symbols', 'families', 'entry_motifs', 'regime_slices', 'normalization_regimes']:
        rows = decomposition.get(section) or {}
        if rows:
            display(Markdown(f'## Best Candidate Decomposition: {section}'))
            _display_rows(
                [
                    {'key': key, **(value if isinstance(value, dict) else {'value': value})}
                    for key, value in rows.items()
                ]
            )
"""
        ),
    ]
    return _notebook(cells)


def build_strategy_factory_research_dossier_notebook(run_root: Path) -> dict[str, Any]:
    cells = [
        _markdown_cell(
            '# Strategy Factory Research Dossier\n\n'
            'This notebook shows the source whitepaper-linked experiments, hypotheses, and promotion contracts driving the factory run.'
        ),
        _code_cell(_shared_loader_code(run_root)),
        _code_cell(
            """display(Markdown('## Runner Contract'))
_display_rows(
    [
        {
            'runner_run_id': RESEARCH.get('runner_run_id'),
            'objective_mode': RESEARCH.get('objective', {}).get('mode'),
            'expected_last_trading_day': RESEARCH.get('objective', {}).get('expected_last_trading_day'),
            'train_days': RESEARCH.get('objective', {}).get('train_days'),
            'holdout_days': RESEARCH.get('objective', {}).get('holdout_days'),
        }
    ]
)
"""
        ),
        _code_cell(
            """experiments = RESEARCH.get('source_experiments') or []
if experiments:
    display(Markdown('## Source Experiments'))
    columns = [
        'source_run_id',
        'experiment_id',
        'family_template_id',
        'hypothesis',
        'paper_claim_links',
        'expected_failure_modes',
        'promotion_contract',
    ]
    _display_rows(_project_rows(experiments, columns), columns=columns)
"""
        ),
        _code_cell(
            """families = RESEARCH.get('families') or []
if families:
    display(Markdown('## Family Templates Used'))
    _display_rows(families)
"""
        ),
        _code_cell(
            """snapshots = RESEARCH.get('dataset_snapshots') or []
if snapshots:
    display(Markdown('## Dataset Snapshots'))
    _display_rows(snapshots)
"""
        ),
    ]
    return _notebook(cells)


def write_strategy_factory_notebooks(run_root: Path) -> tuple[Path, Path]:
    history_path = run_root / 'strategy-factory-history.ipynb'
    dossier_path = run_root / 'strategy-factory-research-dossier.ipynb'
    history_path.write_text(
        json.dumps(build_strategy_factory_history_notebook(run_root), indent=2),
        encoding='utf-8',
    )
    dossier_path.write_text(
        json.dumps(build_strategy_factory_research_dossier_notebook(run_root), indent=2),
        encoding='utf-8',
    )
    return history_path, dossier_path
