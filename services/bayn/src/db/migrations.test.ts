import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { migrationLoader } from './migrations'

test('runtime migration loader preserves the retained controller cutover sequence', () => {
  const migrations = Effect.runSync(migrationLoader)
  expect(migrations.filter(([id]) => id >= 187 && id <= 219).map(([id, name]) => [id, name])).toEqual([
    [187, 'inference_request_generation_index'],
    [188, 'jev_box_inference'],
    [189, 'native_protection_cancel_receipts'],
    [190, 'settle_retired_jev_batches'],
    [191, 'execution_controller_atomic_rotation'],
    [192, 'uncapped_paper_turnover'],
    [194, 'broker_notification_receipts'],
    [195, 'jev_inference_work'],
    [196, 'streaming_operational_controller'],
    [197, 'inference_expense_wakeups'],
    [198, 'equity_short_accounting'],
    [199, 'equity_short_observe_cutover'],
    [200, 'native_equity_shorts'],
    [201, 'not_dispatched_visual_evidence'],
    [202, 'protection_release_proofs'],
    [203, 'protection_read_allowance'],
    [204, 'protection_close_plans'],
    [205, 'inference_source_seals'],
    [206, 'durable_broker_source_events'],
    [207, 'native_qualification_calendar'],
    [208, 'reconciliation_source_snapshots'],
    [209, 'qualification_authority_witness'],
    [210, 'paired_qualification_admission'],
    [211, 'durable_broker_activities'],
    [212, 'risk_symmetry_observe_cutover'],
    [213, 'risk_symmetry_admission'],
    [214, 'single_controller_observation'],
    [215, 'execution_expected_session'],
    [216, 'stop_floor_reward_risk_observe_cutover'],
    [217, 'stop_floor_reward_risk_admission'],
    [218, 'v43_paper_settlement'],
    [219, 'positive_net_target_admission'],
  ])
  expect(migrations.filter(([id]) => id >= 220).map(([id, name]) => [id, name])).toEqual([
    [220, 'intraday_alpha_admission'],
    [221, 'v44_paper_settlement'],
    [222, 'intraday_alpha_v2_admission'],
    [223, 'intraday_alpha_v1_paper_settlement'],
    [224, 'strategy_bound_qualification'],
    [225, 'alpha_baseline_preparation'],
    [226, 'audit_reader_grants'],
    [227, 'audit_reader_view_grant'],
    [228, 'intraday_alpha_v3_admission'],
    [229, 'intraday_alpha_v2_paper_settlement'],
    [230, 'execution_quality_audit_views'],
  ])
})

test('runtime migration loader schedules staged transport after the retained chart checkpoint', () => {
  const migrations = Effect.runSync(migrationLoader)
  const identities = migrations.map(([id, name]) => [id, name])
  expect(identities.filter(([id]) => id === 151 || id === 152 || id === 153 || id === 154)).toEqual([
    [151, 'chart_dispatch_checkpoints'],
    [152, 'funded_source_anchors'],
    [153, 'staged_chart_transport'],
    [154, 'market_entry_questions'],
  ])
  expect(new Set(migrations.map(([id]) => id)).size).toBe(migrations.length)
  expect(migrations.map(([id]) => id)).toEqual(migrations.map(([id]) => id).toSorted((left, right) => left - right))
})
