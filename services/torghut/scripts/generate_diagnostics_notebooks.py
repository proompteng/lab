#!/usr/bin/env python3
"""Generate the canonical, output-free Torghut diagnostics notebooks."""

from __future__ import annotations

import hashlib
from pathlib import Path
from textwrap import dedent

import nbformat
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK_DIR = ROOT / "notebooks"

METADATA = {
    "kernelspec": {
        "display_name": "Python 3 (Torghut)",
        "language": "python",
        "name": "python3",
    },
    "language_info": {"name": "python", "version": "3.11"},
}

SETUP = dedent(
    """
    import json
    import math

    import pandas as pd
    import plotly.express as px
    import plotly.graph_objects as go
    from IPython.display import HTML, display
    from plotly.subplots import make_subplots

    from app.notebook_data import (
        Window,
        adapter_from_environment,
        capital_authority,
        execution_evidence,
        flow_snapshot,
        mode_banner,
        strategy_lifecycle,
    )

    adapter = globals().get('adapter') or adapter_from_environment()
    banner = mode_banner(adapter)
    banner_color = '#9a6700' if adapter.mode == 'fixture' else '#b42318'
    display(HTML(f'''<div style="padding:14px 18px;border:2px solid {banner_color};border-radius:8px;
      font-weight:700;background:#fff8e6;margin-bottom:14px">{banner}</div>'''))

    def bounded_points(frame, series_column, *, time_column='event_ts', preferred=5000):
        # Deterministically thin display points while preserving each series.
        if frame.empty or len(frame) <= preferred:
            return frame.copy()
        series_count = max(1, frame[series_column].nunique())
        per_series = max(2, preferred // series_count)
        chunks = []
        for _, group in frame.sort_values(time_column).groupby(series_column, sort=True):
            stride = max(1, math.ceil(len(group) / per_series))
            chunks.append(group.iloc[::stride])
        result = pd.concat(chunks, ignore_index=True)
        if len(result) > 10000:
            raise ValueError('figure point cap exceeded after deterministic thinning')
        return result

    def bounded_rows(frame, *, preferred=5000):
        if frame.empty or len(frame) <= preferred:
            return frame.copy()
        stride = max(1, math.ceil(len(frame) / preferred))
        result = frame.iloc[::stride].head(10000).copy()
        if len(result) > 10000:
            raise ValueError('figure point cap exceeded after deterministic thinning')
        return result

    def snapshot_frame(snapshot, name):
        if name not in snapshot.datasets:
            return pd.DataFrame()
        return snapshot.frame(name)

    def empty_panel(message):
        display(HTML(f'<div style="padding:18px;border:1px solid #d0d5dd;border-radius:8px;color:#475467">{message}</div>'))
    """
).strip()


def _write(name: str, cells: list[nbformat.NotebookNode]) -> None:
    for index, cell in enumerate(cells):
        cell["id"] = hashlib.sha256(f"{name}:{index}".encode()).hexdigest()[:12]
    notebook = new_notebook(cells=cells, metadata=METADATA)
    path = NOTEBOOK_DIR / name
    nbformat.validate(notebook)
    nbformat.write(notebook, path)


def system_flow() -> list[nbformat.NotebookNode]:
    return [
        new_markdown_cell(
            dedent(
                """
                # Torghut system flow

                **TL;DR.** This notebook checks whether typed equities, options, and Hyperliquid features are arriving and
                whether their observable fields are usable. Equities use the latest completed/current market session;
                options use 60 minutes; Hyperliquid uses 30 minutes. A closed exchange session is `expected_idle`, not a
                false outage. Hyperliquid `event_ts` is the interval end; ingestion freshness comes from `ingest_ts` and
                `source_lag_seconds`.

                The notebook never scans raw `hyperliquid_bbo` and never substitutes fixtures in live mode.
                """
            ).strip()
        ),
        new_markdown_cell(
            "## Context and method\n\nAll source queries are bounded, typed, parameterized, and implemented in `app.notebook_data` so notebook cells contain no hidden query logic."
        ),
        new_code_cell(SETUP),
        new_code_cell(
            dedent(
                """
                snapshots = {
                    'equities': flow_snapshot('equities', Window.sessions(), adapter=adapter),
                    'options': flow_snapshot('options', Window.minutes(60), adapter=adapter),
                    'hyperliquid': flow_snapshot('hyperliquid', Window.minutes(30), adapter=adapter),
                }
                summary_rows = []
                for lane, snapshot in snapshots.items():
                    row = snapshot.provenance().iloc[0].to_dict()
                    age = snapshot.captured_at - snapshot.source_watermark if snapshot.source_watermark else None
                    row.update({
                        'lane': lane,
                        'persisted_rows': len(snapshot.datasets.get(lane, ())),
                        'wall_clock_age_seconds': age.total_seconds() if age else None,
                    })
                    summary_rows.append(row)
                summary = pd.DataFrame(summary_rows)
                display(summary[['lane', 'quality', 'captured_at_utc', 'source_watermark_utc',
                                 'wall_clock_age_seconds', 'persisted_rows', 'truncated', 'query_identifier']])
                """
            ).strip()
        ),
        new_markdown_cell("## Equities — EMA, RSI, and wall-clock age"),
        new_code_cell(
            dedent(
                """
                equities = snapshot_frame(snapshots['equities'], 'equities')
                if equities.empty:
                    empty_panel('No equities rows: ' + '; '.join(snapshots['equities'].messages))
                else:
                    equities['event_ts'] = pd.to_datetime(equities['event_ts'], utc=True)
                    equities_plot = bounded_points(equities, 'symbol')
                    fig = make_subplots(rows=2, cols=1, shared_xaxes=True, vertical_spacing=0.08,
                                        subplot_titles=('EMA 12 vs EMA 26', 'RSI 14'))
                    for symbol, group in equities_plot.groupby('symbol'):
                        fig.add_trace(go.Scatter(x=group.event_ts, y=group.ema12, name=f'{symbol} EMA12'), row=1, col=1)
                        fig.add_trace(go.Scatter(x=group.event_ts, y=group.ema26, name=f'{symbol} EMA26', line={'dash': 'dot'}), row=1, col=1)
                        fig.add_trace(go.Scatter(x=group.event_ts, y=group.rsi14, name=f'{symbol} RSI14'), row=2, col=1)
                    fig.add_hline(y=70, line_dash='dash', line_color='#b42318', row=2, col=1)
                    fig.add_hline(y=30, line_dash='dash', line_color='#027a48', row=2, col=1)
                    fig.update_layout(title='Latest/current equities session — typed minute aggregates', height=760, hovermode='x unified')
                    fig.update_yaxes(title_text='price', row=1, col=1)
                    fig.update_yaxes(title_text='RSI', range=[0, 100], row=2, col=1)
                    fig.show()
                    watermark = snapshots['equities'].source_watermark
                    age = snapshots['equities'].captured_at - watermark if watermark else None
                    display(pd.DataFrame([{'market_session_state': snapshots['equities'].quality,
                                           'wall_clock_age_seconds': age.total_seconds() if age else None,
                                           'latest_event_ts': equities.event_ts.max()}]))
                """
            ).strip()
        ),
        new_markdown_cell("## Options — ATM IV, skew, and snapshot coverage"),
        new_code_cell(
            dedent(
                """
                options = snapshot_frame(snapshots['options'], 'options')
                if options.empty:
                    empty_panel('No options rows: ' + '; '.join(snapshots['options'].messages))
                else:
                    options['event_ts'] = pd.to_datetime(options['event_ts'], utc=True)
                    options_plot = bounded_points(options, 'underlying_symbol')
                    fig = make_subplots(rows=3, cols=1, shared_xaxes=True,
                                        subplot_titles=('ATM implied volatility', '25-delta call/put skew', 'Snapshot coverage'))
                    for symbol, group in options_plot.groupby('underlying_symbol'):
                        fig.add_trace(go.Scatter(x=group.event_ts, y=group.atm_iv, name=f'{symbol} ATM IV'), row=1, col=1)
                        fig.add_trace(go.Scatter(x=group.event_ts, y=group.call_put_skew_25d, name=f'{symbol} skew'), row=2, col=1)
                        fig.add_trace(go.Scatter(x=group.event_ts, y=group.snapshot_coverage_ratio, name=f'{symbol} snapshot coverage'), row=3, col=1)
                        fig.add_trace(go.Scatter(x=group.event_ts, y=group.hot_contract_coverage_ratio, name=f'{symbol} hot-contract coverage', line={'dash': 'dot'}), row=3, col=1)
                    fig.update_layout(title='Options surface — last 60 minutes', height=820, hovermode='x unified')
                    fig.update_yaxes(tickformat='.1%', row=1, col=1)
                    fig.update_yaxes(tickformat='.1%', row=3, col=1, range=[0, 1.05])
                    fig.show()
                    display(options.groupby('feature_quality_status', dropna=False).size().rename('rows').reset_index())
                """
            ).strip()
        ),
        new_markdown_cell("## Hyperliquid — latest-ingest interval state"),
        new_code_cell(
            dedent(
                """
                hyper = snapshot_frame(snapshots['hyperliquid'], 'hyperliquid')
                if hyper.empty:
                    empty_panel('No Hyperliquid rows: ' + '; '.join(snapshots['hyperliquid'].messages))
                else:
                    hyper['event_ts'] = pd.to_datetime(hyper['event_ts'], utc=True)
                    hyper['series'] = hyper['coin'].astype(str) + ' ' + hyper['interval'].astype(str)
                    hyper_plot = bounded_points(hyper, 'series')
                    fig = make_subplots(rows=3, cols=1, shared_xaxes=True,
                                        subplot_titles=('Price by deduplicated interval', 'Regime', 'Source lag (seconds)'))
                    for series, group in hyper_plot.groupby('series'):
                        fig.add_trace(go.Scatter(x=group.event_ts, y=group.price, name=series), row=1, col=1)
                        fig.add_trace(go.Scatter(x=group.event_ts, y=group.regime, name=f'{series} regime', mode='markers'), row=2, col=1)
                        fig.add_trace(go.Scatter(x=group.event_ts, y=group.source_lag_seconds, name=f'{series} lag'), row=3, col=1)
                    fig.update_layout(title='Hyperliquid typed features — event_ts is interval end', height=900, hovermode='x unified')
                    fig.update_yaxes(title_text='price', row=1, col=1)
                    fig.update_yaxes(title_text='regime', row=2, col=1)
                    fig.update_yaxes(title_text='seconds', row=3, col=1)
                    fig.show()
                    display(hyper.groupby(['coin', 'interval', 'regime'], dropna=False).size().rename('rows').reset_index())
                """
            ).strip()
        ),
        new_markdown_cell(
            "## Takeaways\n\nUse the quality state, source watermark, wall-clock age, and explicit empty-state message together. A rendered chart proves observability, not profitability or capital authority."
        ),
    ]


def strategy_lifecycle_notebook() -> list[nbformat.NotebookNode]:
    return [
        new_markdown_cell(
            dedent(
                """
                # Torghut strategy lifecycle

                **TL;DR.** This notebook follows decisions into executions through the verified
                `executions.trade_decision_id` key, reports linked and unlinked executions, and measures TCA coverage.
                Rejected-signal outcomes remain a separate population because no stable signal-to-decision key exists.
                It intentionally does not fabricate a signal/price/order overlay.
                """
            ).strip()
        ),
        new_markdown_cell(
            "## Context and method\n\nThe default window is 30 days. Set `strategy_id` to a UUID to scope proven decision/execution lineage; rejection evidence remains unscoped and visibly separate."
        ),
        new_code_cell(SETUP),
        new_code_cell(
            dedent(
                """
                strategy_id = None
                snapshot = strategy_lifecycle(strategy_id, Window.days(30), adapter=adapter)
                display(snapshot.provenance())
                decisions = snapshot_frame(snapshot, 'decision_status')
                executions = snapshot_frame(snapshot, 'execution_links')
                rejections = snapshot_frame(snapshot, 'rejection_reasons')
                """
            ).strip()
        ),
        new_markdown_cell("## Decision status by strategy and day"),
        new_code_cell(
            dedent(
                """
                if decisions.empty:
                    empty_panel('No decision rows: ' + '; '.join(snapshot.messages))
                else:
                    decisions['bucket_start'] = pd.to_datetime(decisions['bucket_start'], utc=True)
                    decision_daily = decisions.groupby(['bucket_start', 'status'], as_index=False)['decision_count'].sum()
                    fig = px.bar(decision_daily, x='bucket_start', y='decision_count', color='status',
                                 title='Decision lifecycle statuses by day', barmode='stack',
                                 labels={'bucket_start': 'UTC day', 'decision_count': 'decisions'})
                    fig.update_layout(hovermode='x unified')
                    fig.show()
                    display(decisions.groupby(['strategy_id', 'status'], as_index=False)['decision_count'].sum()
                            .sort_values('decision_count', ascending=False))
                """
            ).strip()
        ),
        new_markdown_cell("## Execution linkage, fills/cancels, and TCA coverage"),
        new_code_cell(
            dedent(
                """
                if executions.empty:
                    empty_panel('No execution rows in the selected window.')
                else:
                    numeric = ['execution_count', 'linked_execution_count', 'unlinked_execution_count', 'tca_count']
                    executions[numeric] = executions[numeric].apply(pd.to_numeric)
                    linkage = executions[numeric].sum().to_frame('count').reset_index(names='measure')
                    fig = px.bar(linkage, x='measure', y='count', color='measure',
                                 title='Execution lineage and TCA coverage', text_auto=True)
                    fig.update_layout(showlegend=False)
                    fig.show()
                    status_table = executions.groupby('status', as_index=False).agg(
                        execution_count=('execution_count', 'sum'),
                        linked_execution_count=('linked_execution_count', 'sum'),
                        unlinked_execution_count=('unlinked_execution_count', 'sum'),
                        tca_count=('tca_count', 'sum'),
                        last_activity_at=('last_activity_at', 'max'),
                    ).sort_values('execution_count', ascending=False)
                    display(status_table)
                    unlinked = executions[executions.unlinked_execution_count > 0]
                    if not unlinked.empty:
                        display(HTML('<div style="padding:12px;border:2px solid #b42318;border-radius:8px;font-weight:700">Unlinked executions require operator review.</div>'))
                        display(unlinked)
                """
            ).strip()
        ),
        new_markdown_cell("## Rejected-signal outcomes (separate lineage)"),
        new_code_cell(
            dedent(
                """
                if rejections.empty:
                    empty_panel('No rejected-signal outcome rows in the selected window.')
                else:
                    rejection_summary = rejections.groupby('reject_reason', as_index=False)['rejected_signal_count'].sum().nlargest(20, 'rejected_signal_count')
                    fig = px.bar(rejection_summary, x='rejected_signal_count', y='reject_reason', orientation='h',
                                 title='Rejected signals by reason — not joined to strategies')
                    fig.update_layout(yaxis={'categoryorder': 'total ascending'})
                    fig.show()
                    display(rejections.sort_values('rejected_signal_count', ascending=False).head(50))
                """
            ).strip()
        ),
        new_markdown_cell(
            "## Takeaways\n\nLinked execution and TCA counts are evidence of lifecycle observability. Unlinked executions and rejection outcomes are reported explicitly; neither is silently attributed to a strategy."
        ),
    ]


def execution_evidence_notebook() -> list[nbformat.NotebookNode]:
    return [
        new_markdown_cell(
            dedent(
                """
                # Torghut execution evidence

                **TL;DR.** This notebook shows 30 days of TCA evidence and up to 180 days of server-aggregated runtime
                ledger history. P&L is always split by `observed_stage` and `account_label`. Historical paper/replay
                evidence is not broker equity. If no current live ledger exists, the notebook renders
                **CURRENT PROFITABILITY UNPROVEN** instead of a zero-P&L line.
                """
            ).strip()
        ),
        new_markdown_cell(
            "## Context and method\n\nSlippage, expected/realized shortfall, divergence, and fill coverage come only from `execution_tca_metrics`. No order payload or decision JSON is selected."
        ),
        new_code_cell(SETUP),
        new_code_cell(
            dedent(
                """
                strategy_id = None
                snapshot = execution_evidence(strategy_id, Window.days(30), adapter=adapter)
                display(snapshot.provenance())
                tca = snapshot_frame(snapshot, 'tca')
                ledger = snapshot_frame(snapshot, 'runtime_ledger')
                ledger_state_rows = snapshot.datasets.get('ledger_state', ())
                ledger_state = ledger_state_rows[0] if ledger_state_rows else {
                    'current_profitability_proven': False,
                    'message': 'CURRENT PROFITABILITY UNPROVEN — runtime-ledger evidence is unavailable.',
                    'historical_ledger_rows': 0,
                }
                if not ledger_state['current_profitability_proven']:
                    display(HTML(f'''<div style="padding:18px;border:3px solid #b42318;border-radius:8px;
                      font-size:20px;font-weight:800;background:#fff1f0">{ledger_state['message']}</div>'''))
                """
            ).strip()
        ),
        new_markdown_cell("## Slippage and shortfall distributions"),
        new_code_cell(
            dedent(
                """
                if tca.empty:
                    empty_panel('No TCA rows in the selected window.')
                else:
                    numeric = ['slippage_bps', 'expected_shortfall_bps_p50', 'expected_shortfall_bps_p95',
                               'realized_shortfall_bps', 'divergence_bps', 'filled_qty']
                    tca[numeric] = tca[numeric].apply(pd.to_numeric, errors='coerce')
                    tca_plot = bounded_rows(tca)
                    fig = px.histogram(tca_plot, x='slippage_bps', color='symbol', marginal='box', nbins=50,
                                       title='Slippage distribution by symbol', labels={'slippage_bps': 'slippage (bps)'})
                    fig.show()
                    scatter = tca_plot.dropna(subset=['expected_shortfall_bps_p50', 'realized_shortfall_bps']).copy()
                    if scatter.empty:
                        empty_panel('Expected versus realized shortfall has no paired observations.')
                    else:
                        fig = px.scatter(scatter, x='expected_shortfall_bps_p50', y='realized_shortfall_bps',
                                         color='symbol', symbol='side', hover_data=['strategy_id', 'execution_id'],
                                         title='Realized versus expected p50 shortfall')
                        diagonal_max = max(scatter.expected_shortfall_bps_p50.max(), scatter.realized_shortfall_bps.max())
                        diagonal_min = min(scatter.expected_shortfall_bps_p50.min(), scatter.realized_shortfall_bps.min())
                        fig.add_shape(type='line', x0=diagonal_min, y0=diagonal_min, x1=diagonal_max, y1=diagonal_max,
                                      line={'dash': 'dash', 'color': '#667085'})
                        fig.show()
                    fig = px.box(tca_plot, x='symbol', y='divergence_bps', color='side', points='outliers',
                                 title='Shortfall divergence by symbol and side')
                    fig.show()
                    fig = px.box(tca_plot, x='strategy_id', y='slippage_bps', color='symbol', points='outliers',
                                 title='Slippage distribution by strategy and symbol')
                    fig.update_xaxes(tickangle=-35)
                    fig.show()
                    tca['has_fill'] = tca['filled_qty'].fillna(0) > 0
                    coverage = tca.groupby(['strategy_id', 'symbol'], dropna=False).agg(
                        tca_rows=('execution_id', 'count'), filled_rows=('has_fill', 'sum'),
                        fill_coverage_ratio=('has_fill', 'mean'), filled_qty=('filled_qty', 'sum'),
                        latest_tca=('computed_at', 'max')).reset_index()
                    display(coverage.sort_values('tca_rows', ascending=False))
                """
            ).strip()
        ),
        new_markdown_cell("## Historical runtime-ledger evidence — not broker equity"),
        new_code_cell(
            dedent(
                """
                if ledger.empty:
                    empty_panel('CURRENT PROFITABILITY UNPROVEN — no runtime-ledger rows exist in the bounded 180-day window.')
                else:
                    ledger['bucket_day'] = pd.to_datetime(ledger['bucket_day'], utc=True)
                    ledger['net_strategy_pnl_after_costs'] = pd.to_numeric(ledger['net_strategy_pnl_after_costs'])
                    ledger['stage_account'] = ledger['observed_stage'].astype(str) + ' / ' + ledger['account_label'].astype(str)
                    ledger_plot = ledger.groupby(['bucket_day', 'stage_account'], as_index=False)['net_strategy_pnl_after_costs'].sum()
                    ledger_plot = bounded_points(ledger_plot, 'stage_account', time_column='bucket_day')
                    fig = px.line(ledger_plot, x='bucket_day', y='net_strategy_pnl_after_costs', color='stage_account',
                                  markers=True, title='Historical runtime-ledger net P&L by stage/account (not broker equity)',
                                  labels={'bucket_day': 'UTC day', 'net_strategy_pnl_after_costs': 'net P&L after modeled costs'})
                    fig.update_layout(hovermode='x unified')
                    fig.show()
                    display(ledger.groupby(['observed_stage', 'account_label'], as_index=False).agg(
                        first_bucket=('bucket_day', 'min'), latest_bucket=('latest_bucket_ended_at', 'max'),
                        fills=('fill_count', 'sum'), net_pnl=('net_strategy_pnl_after_costs', 'sum')))
                """
            ).strip()
        ),
        new_markdown_cell(
            "## Takeaways\n\nTCA coverage and historical ledger evidence diagnose execution quality. They do not establish current profitability, broker equity, or permission to increase capital."
        ),
    ]


def capital_authority_notebook() -> list[nbformat.NotebookNode]:
    return [
        new_markdown_cell(
            dedent(
                """
                # Torghut capital authority

                **TL;DR.** This notebook displays `/trading/status` authority fields and reason codes verbatim. The final
                `action_authority.entry_allowed` value remains authoritative even when a lower-level execution gate,
                broker reconciliation, accounting parity, or capital control reports success. No composite “allowed”
                boolean is calculated here.
                """
            ).strip()
        ),
        new_markdown_cell(
            "## Context and method\n\nThe source is the GET-only scheduler `/trading/status` endpoint. Each component retains its original payload for audit."
        ),
        new_code_cell(SETUP),
        new_code_cell(
            dedent(
                """
                snapshot = capital_authority(adapter=adapter)
                display(snapshot.provenance())
                components = snapshot_frame(snapshot, 'components')
                raw_status_rows = snapshot.datasets.get('raw_status', ())
                raw_status = raw_status_rows[0] if raw_status_rows else {}
                action = raw_status.get('action_authority', {})
                if not isinstance(action.get('entry_allowed'), bool):
                    empty_panel('CAPITAL AUTHORITY UNAVAILABLE — ' + '; '.join(snapshot.messages))
                else:
                    final_value = action['entry_allowed']
                    color = '#027a48' if final_value else '#b42318'
                    label = 'ENTRY ALLOWED' if final_value else 'ENTRY BLOCKED'
                    display(HTML(f'''<div style="padding:20px;border:4px solid {color};border-radius:10px;
                      font-size:24px;font-weight:900">FINAL ACTION AUTHORITY: {label}</div>'''))
                """
            ).strip()
        ),
        new_markdown_cell("## Authority components and verbatim reason codes"),
        new_code_cell(
            dedent(
                """
                if components.empty:
                    empty_panel('Authority components are unavailable.')
                else:
                    display_table = components.drop(columns=['payload']).copy()
                    display_table['reason_codes'] = display_table['reason_codes'].apply(lambda value: json.dumps(value, sort_keys=True))
                    display(display_table)
                """
            ).strip()
        ),
        new_markdown_cell("## Raw authoritative action payload"),
        new_code_cell(
            "display(HTML(f'<pre style=\"white-space:pre-wrap\">{json.dumps(action, indent=2, sort_keys=True, default=str)}</pre>')) if action else empty_panel('Authoritative action payload is unavailable.')"
        ),
        new_markdown_cell("## Component payloads"),
        new_code_cell(
            dedent(
                """
                for row in snapshot.datasets.get('components', ()):
                    display(HTML(f"<h3>{row['component']}</h3><pre style='white-space:pre-wrap'>{json.dumps(row['payload'], indent=2, sort_keys=True, default=str)}</pre>"))
                if not snapshot.datasets.get('components'):
                    empty_panel('Component payloads are unavailable.')
                """
            ).strip()
        ),
        new_markdown_cell(
            "## Takeaways\n\nUse the final action authority and its own reason codes for capital decisions. Lower-level green states are diagnostic inputs, not an override."
        ),
    ]


def main() -> None:
    NOTEBOOK_DIR.mkdir(parents=True, exist_ok=True)
    _write("00-system-flow.ipynb", system_flow())
    _write("10-strategy-lifecycle.ipynb", strategy_lifecycle_notebook())
    _write("20-execution-evidence.ipynb", execution_evidence_notebook())
    _write("30-capital-authority.ipynb", capital_authority_notebook())


if __name__ == "__main__":
    main()
