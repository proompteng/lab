import { expect, test } from 'bun:test'

import baseline from '../fixtures/effect-3.22.1-activation-baseline.json'
import { runEffectMigrationScenarios } from '../../scripts/effect-migration-scenarios'

const normalizeFreshSamples = (scenarios: typeof baseline.scenarios) =>
  Object.fromEntries(Object.entries(scenarios).map(([name, output]) => [name, {
    ...output,
    determinismState: {
      ...output.determinismState,
      timeValues: output.determinismState.timeValues.map(() => 'time'),
      randomValues: output.determinismState.randomValues.map(() => 'random'),
    },
  }]))

test('replays Effect 3 activation states without changing commands or signal batching', async () => {
  const previousStates = Object.fromEntries(
    Object.entries(baseline.scenarios).map(([name, output]) => [name, output.determinismState]),
  )
  const actual = await runEffectMigrationScenarios(previousStates)
  // New tasks sample new clock/random values; their count and recorded positions must stay identical.
  expect(normalizeFreshSamples(actual)).toEqual(normalizeFreshSamples(baseline.scenarios))
  expect(actual.parallelFinal.result).toEqual(['C', 'B'])
  expect(actual.signalFirst.intents[0].input).toEqual([['A']])
})
