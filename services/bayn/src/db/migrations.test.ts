import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { migrationLoader } from './migrations'

test('runtime migration loader schedules atomic controller rotation after retired settlement', () => {
  const migrations = Effect.runSync(migrationLoader)
  expect(migrations.filter(([id]) => id >= 187).map(([id, name]) => [id, name])).toEqual([
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
  ])
  const pending = migrations.filter(([id]) => id > 187).map(([id, name]) => [id, name])

  expect(pending).toEqual([
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
