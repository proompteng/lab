import { expect, test } from 'bun:test'

import { Result } from 'effect'

import { evidence, fixture, preset } from './fixtures.test-support'
import { asset, MacroEtfCoreEvidenceError, Profile } from './policy'
import { computeMacroEtfCoreSignal, replayMacroEtfCoreSignals } from './signals'

const path = (input: ReturnType<typeof fixture>) => computeMacroEtfCoreSignal(preset(), evidence(input))
const fails = (input: ReturnType<typeof fixture>, message: string) => {
  const signal = path(input)
  expect(Result.isFailure(signal) && signal.failure).toBeInstanceOf(MacroEtfCoreEvidenceError)
  expect(Result.isFailure(signal) && signal.failure.message).toContain(message)
}

test('requires a full 100 closes and reviews only on the fixed 42-session cadence', () => {
  fails(fixture(99), 'warmup')
  const first = fixture(100)
  expect(Result.getOrThrow(path(first))).toMatchObject({
    signalDate: first.calendar[99].date,
    executionDate: first.calendar[100].date,
    executionOpenAt: first.calendar[100].openAt,
  })
  expect(Result.getOrThrow(path(fixture(101)))).toBeUndefined()
})

test.each([Profile.F2, Profile.F4])('prefix invariance for %s', (profile) => {
  const prefix = fixture(142)
  const longer = fixture(184)
  for (const row of longer.bars[142]) {
    row.close *= 3
    row.high = row.close * 1.1
  }
  const prior = Result.getOrThrow(computeMacroEtfCoreSignal(preset(profile), evidence(prefix)))
  expect(Result.getOrThrow(replayMacroEtfCoreSignals(preset(profile), evidence(longer)))[1]).toEqual(prior)
})

test.each(['HYG', 'IEF', 'SHY', 'SPY', 'TLT', 'GLD', 'LQD', 'DBC', 'UUP'])(
  'missing %s invalidates the whole observation, even from warmup',
  (symbol) => {
    const input = fixture()
    input.bars[30] = input.bars[30].filter((row) => row.symbol !== symbol)
    fails(input, `Missing required close: ${symbol}`)
  },
)

test('rejects duplicate, out of order, premature, late, invalid, and future evidence globally', () => {
  const duplicate = fixture()
  duplicate.bars[15].push(duplicate.bars[15][0])
  fails(duplicate, 'duplicate')
  const unordered = fixture()
  ;[unordered.calendar[1], unordered.calendar[2]] = [unordered.calendar[2], unordered.calendar[1]]
  fails(unordered, 'non-monotonic')
  const premature = fixture()
  premature.bars[0][0].availableAt = premature.calendar[0].closeAt - 1
  fails(premature, 'Premature')
  const late = fixture()
  late.bars[0][0].availableAt = late.calendar[1].openAt + 1
  fails(late, 'Premature')
  const malformed = fixture()
  const optional = malformed.bars[150].find((row) => row.symbol === 'XLC')
  if (optional === undefined) throw new Error('Missing XLC fixture')
  optional.high = optional.low
  fails(malformed, 'malformed')
  const future = fixture()
  future.bars[183][0].date = future.calendar[184].date
  fails(future, 'unordered')
  const missed = fixture()
  missed.asOf++
  fails(missed, 'Missed next-open')
})

test('rejects a hash mismatch or relabeled archive', () => {
  const input = evidence(fixture(100))
  input.snapshot.bars[0][0].close += 0.01
  const changed = computeMacroEtfCoreSignal(preset(), input)
  expect(Result.isFailure(changed) && changed.failure.message).toContain('SHA-256 mismatch')
  const relabeled = computeMacroEtfCoreSignal(preset(), {
    ...input,
    snapshot: { ...input.snapshot, adjustment: 'raw' },
  })
  expect(Result.isFailure(relabeled) && relabeled.failure).toBeInstanceOf(MacroEtfCoreEvidenceError)
})

test.each([Profile.F2, Profile.F4])(
  'masks missing optional candidate weights to zero after smoothing for %s',
  (profile) => {
    const full = fixture(184)
    const fullSignal = Result.getOrThrow(computeMacroEtfCoreSignal(preset(profile), evidence(full)))
    expect(fullSignal).toBeDefined()
    expect(fullSignal?.weights[asset.XLC]).toBeGreaterThan(0)

    const missingXlc = fixture(184)
    missingXlc.bars[183] = missingXlc.bars[183].filter((row) => row.symbol !== 'XLC')
    const maskedSignal = Result.getOrThrow(computeMacroEtfCoreSignal(preset(profile), evidence(missingXlc)))
    expect(maskedSignal).toBeDefined()
    expect(maskedSignal?.weights[asset.XLC]).toBe(0)
  },
)
