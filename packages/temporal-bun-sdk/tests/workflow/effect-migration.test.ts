import { expect, test } from 'bun:test'

import baseline from '../fixtures/effect-3.22.1-activation-baseline.json'
import { runEffectMigrationScenarios } from '../../scripts/effect-migration-scenarios'

test('rejects incompatible Effect 3 internal clock samples instead of silently discarding history', async () => {
  const previousStates = Object.fromEntries(
    Object.entries(baseline.scenarios).map(([name, output]) => [name, output.determinismState]),
  )
  await expect(runEffectMigrationScenarios(previousStates)).rejects.toMatchObject({
    name: 'WorkflowNondeterminismError',
    message: 'Workflow did not replay all history entries',
    details: { hint: 'missingCommands=0 missingRandom=0 missingTime=4' },
  })
})

test('Effect 4 histories replay command ordering and signal batching across task activations', async () => {
  const actual = await runEffectMigrationScenarios()
  const previousStates = Object.fromEntries(
    Object.entries(actual).map(([name, output]) => [name, output.determinismState]),
  )
  expect(await runEffectMigrationScenarios(previousStates)).toEqual(actual)
  expect(actual.parallelFirst.intents.map((intent) => intent.activityId)).toEqual(['A', 'B'])
  expect(actual.parallelSecond.intents.map((intent) => intent.activityId)).toEqual(['C'])
  expect(actual.parallelFinal.result).toEqual(['C', 'B'])
  expect(actual.signalFirst.intents[0].input).toEqual([['A']])
})
