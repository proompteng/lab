import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { migrationLoader } from './migrations'

test('runtime migration loader schedules staged transport after the retained chart checkpoint', () => {
  const migrations = Effect.runSync(migrationLoader)
  const identities = migrations.map(([id, name]) => [id, name])
  expect(identities.filter(([id]) => id === 151 || id === 152 || id === 153)).toEqual([
    [151, 'chart_dispatch_checkpoints'],
    [152, 'funded_source_anchors'],
    [153, 'staged_chart_transport'],
  ])
  expect(new Set(migrations.map(([id]) => id)).size).toBe(migrations.length)
  expect(migrations.map(([id]) => id)).toEqual(migrations.map(([id]) => id).toSorted((left, right) => left - right))
})
