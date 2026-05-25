from __future__ import annotations

import json
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from scripts import assemble_runtime_ledger_proof_packet as packet


def _status(*, blockers: list[str] | None = None) -> dict[str, object]:
    return {
        'mode': 'paper',
        'running': True,
        'live_submission_gate': {
            'allowed': not blockers,
            'reason': 'allowed' if not blockers else blockers[0],
            'blocked_reasons': blockers or [],
        },
        'proof_floor': {
            'blocking_reasons': [],
        },
    }


def _paper_route_evidence(
    *,
    import_ready: bool = True,
    import_blockers: list[str] | None = None,
) -> dict[str, object]:
    blockers = import_blockers if import_blockers is not None else []
    return {
        'schema_version': 'torghut.paper-route-evidence.v1',
        'next_paper_route_runtime_window_targets': {
            'schema_version': 'torghut.next-paper-route-runtime-window-targets.v1',
            'target_count': 1,
            'session_window': {
                'start': '2026-05-26T13:30:00+00:00',
                'end': '2026-05-26T20:00:00+00:00',
            },
            'session_readiness': {
                'import_ready': import_ready,
                'import_blockers': blockers,
            },
            'runtime_window_import_handoff': {
                'runner': 'scripts/renew_latest_empirical_promotion_jobs.py',
                'import_ready': import_ready,
                'import_blockers': blockers,
                'promotion_allowed': False,
                'final_promotion_authorized': False,
            },
            'targets': [
                {
                    'candidate_id': 'c88421d619759b2cfaa6f4d0',
                    'hypothesis_id': 'H-PAIRS-01',
                    'observed_stage': 'paper',
                    'strategy_family': 'microbar_cross_sectional_pairs',
                    'strategy_name': 'microbar-pairs-vwap-cap-safe',
                    'account_label': 'TORGHUT_SIM',
                    'source_manifest_ref': 'config/trading/hypotheses/h-pairs-01.json',
                    'window_start': '2026-05-26T13:30:00+00:00',
                    'window_end': '2026-05-26T20:00:00+00:00',
                    'promotion_allowed': False,
                    'final_promotion_authorized': False,
                }
            ],
        },
    }


def _runtime_import(
    *,
    proof_status: str = 'ok',
    proof_blockers: list[str] | None = None,
    authoritative: bool = True,
) -> dict[str, object]:
    blocker_payloads = [{'blocker': blocker} for blocker in proof_blockers or []]
    return {
        'status': 'ok',
        'proof_status': proof_status,
        'proof_blockers': blocker_payloads,
        'target_count': 1,
        'imports': [
            {
                'status': 'ok',
                'proof_status': proof_status,
                'proof_blockers': blocker_payloads,
                'candidate_id': 'c88421d619759b2cfaa6f4d0',
                'hypothesis_id': 'H-PAIRS-01',
                'observed_stage': 'paper',
                'strategy_family': 'microbar_cross_sectional_pairs',
                'strategy_name': 'microbar-pairs-vwap-cap-safe',
                'account_label': 'TORGHUT_SIM',
                'window_start': '2026-05-26T13:30:00+00:00',
                'window_end': '2026-05-26T20:00:00+00:00',
                'summary': {
                    'promotion_allowed': authoritative,
                    'runtime_observation': {
                        'authoritative': authoritative,
                        'authority_reason': 'runtime_ledger_profit_proof_present'
                        if authoritative
                        else 'runtime_without_runtime_ledger_profit_proof',
                    },
                },
            }
        ],
    }


def _completion(
    *,
    status: str = 'satisfied',
    net_pnl: str = '650',
    trading_days: int = 1,
    expectancy_bps: str = '13',
    ledger_refs: list[str] | None = None,
    unbacked_refs: list[str] | None = None,
) -> dict[str, object]:
    return {
        'doc_id': 'doc29',
        'summary': {'all_satisfied': status == 'satisfied'},
        'gates': [
            {
                'gate_id': packet.DOC29_LIVE_SCALE_GATE,
                'status': status,
                'candidate_id': 'c88421d619759b2cfaa6f4d0',
                'runtime_ledger_summary': {
                    'runtime_ledger_bucket_count': 1,
                    'runtime_ledger_fill_count': 4,
                    'runtime_ledger_closed_trade_count': 2,
                    'runtime_ledger_filled_notional': '50000',
                    'runtime_ledger_net_strategy_pnl_after_costs': net_pnl,
                    'runtime_ledger_post_cost_expectancy_bps': expectancy_bps,
                    'runtime_ledger_observed_trading_day_count': trading_days,
                },
                'db_row_refs': {
                    'strategy_runtime_ledger_buckets': ledger_refs
                    if ledger_refs is not None
                    else ['strategy-runtime-ledger-buckets:H-PAIRS-01:2026-05-26'],
                    'runtime_ledger_unbacked_hypothesis_metric_windows': unbacked_refs
                    if unbacked_refs is not None
                    else [],
                },
            }
        ],
    }


class TestRuntimeLedgerProofPacket(TestCase):
    def test_packet_allows_only_complete_post_cost_runtime_ledger_proof(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            min_runtime_ledger_net_pnl=Decimal('500'),
            min_runtime_ledger_daily_net_pnl=Decimal('500'),
            min_runtime_ledger_trading_days=1,
            generated_at='2026-05-26T21:05:00+00:00',
        )

        self.assertTrue(result['ok'], result)
        self.assertEqual(result['schema_version'], packet.SCHEMA_VERSION)
        self.assertEqual(result['verdict'], 'promotion_authority_allowed')
        self.assertEqual(result['promotion_authority']['blocking_reasons'], [])
        self.assertEqual(result['candidate']['hypothesis_id'], 'H-PAIRS-01')
        self.assertEqual(
            result['checks']['runtime_ledger_post_cost_profit_target']['observed'][
                'daily_net_pnl_after_costs'
            ],
            '650',
        )

    def test_packet_waits_before_paper_route_window_is_importable(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(
                import_ready=False,
                import_blockers=['paper_route_session_window_not_open'],
            ),
            generated_at='2026-05-25T21:05:00+00:00',
        )

        self.assertFalse(result['ok'])
        self.assertEqual(result['verdict'], 'waiting_for_runtime_window')
        self.assertEqual(
            result['promotion_authority']['blocking_reasons'],
            ['paper_route_session_window_not_open'],
        )
        self.assertEqual(
            result['required_actions'],
            ['wait_for_regular_session_runtime_window'],
        )
        self.assertFalse(
            result['checks']['runtime_window_import_proof']['observed'][
                'runtime_import_due'
            ]
        )

    def test_packet_blocks_non_authoritative_import_and_weak_daily_profit(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(
                proof_status='blocked',
                proof_blockers=['runtime_without_runtime_ledger_profit_proof'],
                authoritative=False,
            ),
            completion_status=_completion(net_pnl='600', trading_days=3),
            min_runtime_ledger_net_pnl=Decimal('500'),
            min_runtime_ledger_daily_net_pnl=Decimal('500'),
            min_runtime_ledger_trading_days=1,
            generated_at='2026-05-26T21:05:00+00:00',
        )

        self.assertFalse(result['ok'])
        self.assertEqual(result['verdict'], 'blocked')
        self.assertIn(
            'runtime_without_runtime_ledger_profit_proof',
            result['promotion_authority']['blocking_reasons'],
        )
        self.assertIn(
            'runtime_ledger_daily_net_pnl_below_target',
            result['promotion_authority']['blocking_reasons'],
        )

    def test_cli_writes_packet_and_returns_nonzero_for_blocked_packet(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / 'status.json'
            paper_path = tmp_path / 'paper.json'
            import_path = tmp_path / 'import.json'
            completion_path = tmp_path / 'completion.json'
            output_path = tmp_path / 'packet.json'
            status_path.write_text(json.dumps(_status()), encoding='utf-8')
            paper_path.write_text(json.dumps(_paper_route_evidence()), encoding='utf-8')
            import_path.write_text(
                json.dumps(
                    _runtime_import(
                        proof_status='blocked',
                        proof_blockers=['runtime_ledger_pnl_basis_missing'],
                    )
                ),
                encoding='utf-8',
            )
            completion_path.write_text(json.dumps(_completion()), encoding='utf-8')

            exit_code = packet.main(
                [
                    '--status-file',
                    str(status_path),
                    '--paper-route-evidence-file',
                    str(paper_path),
                    '--runtime-window-import-file',
                    str(import_path),
                    '--completion-file',
                    str(completion_path),
                    '--output-file',
                    str(output_path),
                ]
            )

            self.assertEqual(exit_code, 1)
            payload = json.loads(output_path.read_text(encoding='utf-8'))
            self.assertEqual(payload['verdict'], 'blocked')
            self.assertIn(
                'runtime_ledger_pnl_basis_missing',
                payload['promotion_authority']['blocking_reasons'],
            )

    def test_cli_can_emit_waiting_packet_before_import_outputs_exist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            status_path = tmp_path / 'status.json'
            paper_path = tmp_path / 'paper.json'
            output_path = tmp_path / 'packet.json'
            status_path.write_text(json.dumps(_status()), encoding='utf-8')
            paper_path.write_text(
                json.dumps(
                    _paper_route_evidence(
                        import_ready=False,
                        import_blockers=['paper_route_session_window_not_open'],
                    )
                ),
                encoding='utf-8',
            )

            exit_code = packet.main(
                [
                    '--status-file',
                    str(status_path),
                    '--paper-route-evidence-file',
                    str(paper_path),
                    '--output-file',
                    str(output_path),
                ]
            )

            self.assertEqual(exit_code, 1)
            payload = json.loads(output_path.read_text(encoding='utf-8'))
            self.assertEqual(payload['verdict'], 'waiting_for_runtime_window')
