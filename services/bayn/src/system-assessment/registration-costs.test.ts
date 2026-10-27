import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { JevResearchPolicy } from '../jev/acceptance'
import type { InferenceRateSchema } from '../inference-costs'
import { registrationFixture, replayRateCardFixture } from './fixtures.test-support'
import { validateSystemRegistration } from './policy'

const rateCard = (inputRate: string) =>
  replayRateCardFixture({
    jev: { inputMicrosPerMillionTokens: inputRate, outputMicrosPerMillionTokens: '0' },
    chart: {
      inputMicrosPerMillionTokens: '1',
      outputMicrosPerMillionTokens: '0',
      cachedInputMicrosPerMillionTokens: '0',
      cacheWriteInputMicrosPerMillionTokens: '0',
    },
  })

test('each policy preserves the frozen Jev tariff floor before the prospective window opens', () => {
  const registration = registrationFixture()
  for (const policy of Object.values(JevResearchPolicy))
    for (const rate of ['0', '1', '41999', '42000', '42001', '100000000']) {
      const result = validateSystemRegistration({
        ...registration,
        policies: registration.policies.map((definition) =>
          definition.policy === policy ? { ...definition, inferenceRateCard: rateCard(rate) } : definition,
        ),
      })
      expect(Result.isSuccess(result)).toBe(BigInt(rate) >= 42000n)
    }
})

test('a cheaper rate confined to history cannot lower any registered session cost', () => {
  const registration = registrationFixture()
  const firstOpen = registration.calendar.sessions[0]?.openAt
  if (firstOpen === undefined) throw new Error('Missing fixture session')
  const inferenceRateCard = {
    ...rateCard('42000'),
    rates: rateCard('42000').rates.flatMap((rate): (typeof InferenceRateSchema.Type)[] =>
      rate.provider === 'typesafe'
        ? [
            { ...rate, inputMicrosPerMillionTokens: '1', effectiveUntil: firstOpen },
            { ...rate, effectiveFrom: firstOpen },
          ]
        : [rate],
    ),
  }
  expect(
    Result.isSuccess(
      validateSystemRegistration({
        ...registration,
        policies: registration.policies.map((definition) => ({ ...definition, inferenceRateCard })),
      }),
    ),
  ).toBe(true)
})

test('an intra-window discount is rejected even when it begins at the final close', () => {
  const registration = registrationFixture()
  const lastClose = registration.calendar.sessions.at(-1)?.closeAt
  if (lastClose === undefined) throw new Error('Missing fixture session')
  const inferenceRateCard = {
    ...rateCard('42000'),
    rates: rateCard('42000').rates.flatMap((rate): (typeof InferenceRateSchema.Type)[] =>
      rate.provider === 'typesafe'
        ? [
            { ...rate, effectiveUntil: lastClose },
            { ...rate, inputMicrosPerMillionTokens: '41999', effectiveFrom: lastClose },
          ]
        : [rate],
    ),
  }
  expect(
    Result.isFailure(
      validateSystemRegistration({
        ...registration,
        policies: registration.policies.map((definition) => ({ ...definition, inferenceRateCard })),
      }),
    ),
  ).toBe(true)
})
