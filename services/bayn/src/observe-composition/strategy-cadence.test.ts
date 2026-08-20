import { expect, test } from 'bun:test'

import { fixtureRuntime } from '../app-test-support'
import { strategyAllowsMutationCadence, strategyCycleCadence } from './strategy-cadence'

test('refuses to execute a multi-session strategy under an every-session mutation cadence', () => {
  expect(strategyAllowsMutationCadence(fixtureRuntime, 'MONTHLY')).toBe(true)
  expect(strategyAllowsMutationCadence(fixtureRuntime, 'EVERY_SESSION')).toBe(false)
  expect(strategyAllowsMutationCadence(fixtureRuntime, 'CAPITAL_BOOTSTRAP')).toBe(false)
})

test('allows an intraday strategy under an every-session mutation cadence', () => {
  const intraday = {
    definition: { ...fixtureRuntime.definition, holdingPeriod: 'INTRADAY' as const },
    provenance: fixtureRuntime.provenance,
  }

  expect(strategyCycleCadence(fixtureRuntime)).toBeUndefined()
  expect(strategyCycleCadence(intraday)).toBe('EVERY_SESSION')
  expect(strategyAllowsMutationCadence(intraday, 'EVERY_SESSION')).toBe(true)
})
