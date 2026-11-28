import { expect, test } from 'bun:test'

import { Result } from 'effect'

import { preset } from './fixtures.test-support'
import { decodeMacroEtfCorePolicy, MacroEtfCoreEvidenceError, Profile } from './policy'

test('registers immutable profiles and hashes canonical policy contents', () => {
  const f2 = Result.getOrThrow(decodeMacroEtfCorePolicy(preset(Profile.F2)))
  const f4 = Result.getOrThrow(decodeMacroEtfCorePolicy(preset(Profile.F4)))
  const reordered = Result.getOrThrow(decodeMacroEtfCorePolicy({ profile: Profile.F2, schema: f2.schema }))
  expect(f2.hash).toBe(reordered.hash)
  expect(f2.hash).toBe('35b31d3c123a5f8a566eca64723acb297fe11f1683f1269fed4383a045e37c66')
  expect(f4.hash).toBe('7a397284bfbe1907c04dd24da56275f59f975fe00ac7e1f859784f25b9dad08c')
  expect(f2.settings).toEqual({ trial: 'F2-42-IEF-100-10', credit: 'IEF', secondary: 'LQD' })
  expect(f4.settings).toEqual({
    trial: 'F4-42-1-LQD-parity',
    credit: 'LQD',
    secondary: 'IEF',
    mix: [0.5, 0.25, 0.25],
    volatilityPower: 1,
  })
  expect(Object.isFrozen(f2.universe)).toBe(true)
  expect(Object.isFrozen(f2.parameters.offense[0].members)).toBe(true)
})

test.each([{}, { ...preset(), cadence: 21 }, { ...preset(), profile: 'F1' }, { ...preset(), schema: 'v2' }])(
  'fails closed for a nonregistered policy: %j',
  (input) => {
    const result = decodeMacroEtfCorePolicy(input)
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(MacroEtfCoreEvidenceError)
  },
)
