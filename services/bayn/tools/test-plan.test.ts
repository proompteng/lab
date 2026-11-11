import { expect, test } from 'bun:test'
import { planTests } from './test-plan'

test('unit-only changes execute the changed tests in one existing shard', () => {
  expect(
    planTests(
      ['services/bayn/src/market-data/streaming/kafka.test.ts', 'services/bayn/src/reconciliation/algebra.test.ts'],
      false,
    ),
  ).toEqual({
    kind: 'unit',
    files: ['src/market-data/streaming/kafka.test.ts', 'src/reconciliation/algebra.test.ts'],
    shards: [1],
  })
})

test('production, shared fixtures, integration, unknown and exact-revision inputs keep full coverage', () => {
  for (const file of [
    'services/bayn/src/main.ts',
    'services/bayn/src/test-environment.test-support.ts',
    'services/bayn/src/db/entry-inference-postgres.integration.test.ts',
    'services/bayn/src/shadow-decision.test.ts',
    'services/bayn/migrations/0192.ts',
    'bun.lock',
    'package.json',
    'services/bayn/scripts/retained-jev-node.test.ts',
    'services/dorvud/platform/build.gradle.kts',
  ]) {
    expect(planTests(['services/bayn/src/risk.test.ts', file], false).kind).toBe('full')
  }
  expect(planTests([], false).kind).toBe('full')
  expect(planTests(['services/bayn/src/risk.test.ts'], true).kind).toBe('full')
})
